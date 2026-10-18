import RAPIER from '@dimforge/rapier3d-compat';
import type { Body, Command, Entity, Plugin, Vec3 } from '../core/index.js';

export interface PhysicsOptions {
  /** World units are metres, time is seconds. Y-up characters use the Y component. */
  gravity?: Vec3;
}

export interface PhysicsInspection {
  bodies: number;
  characters: number;
  grounded: Record<string, boolean>;
}

export interface PhysicsService {
  inspect(): PhysicsInspection;
}

interface CharacterState {
  controller: RAPIER.KinematicCharacterController;
  velocity: Vec3;
  verticalVelocity: number;
  jump: boolean;
  grounded: boolean;
}

interface BodyState {
  entity: Entity;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  type: Body['type'];
  character?: CharacterState;
}

// Sharing WASM initialization is safe; each installation creates its own physics world.
let initialization: Promise<void> | undefined;

function vector(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 ||
      ![0, 1, 2].every((index) => typeof value[index] === 'number' && Number.isFinite(value[index]) && Math.abs(value[index]) <= 1e6)) {
    throw new TypeError(`${label} must be three finite numbers between -1000000 and 1000000`);
  }
  return [value[0], value[1], value[2]];
}

function xyz(value: Vec3): RAPIER.Vector {
  return { x: value[0], y: value[1], z: value[2] };
}

function validatePhysicalValues(entity: Entity, body: Body): void {
  vector(entity.position, `${entity.id} position`);
  const size = vector(body.size, `${entity.id} body.size`);
  if (size.some(value => value < 1e-4)) throw new RangeError(`${entity.id} body dimensions must be at least 0.0001 metres`);
  if (body.mass !== undefined && (!Number.isFinite(body.mass) || body.mass < 1e-6 || body.mass > 1e6)) {
    throw new RangeError(`${entity.id} body.mass must be between 0.000001 and 1000000 kilograms`);
  }
  if (body.friction !== undefined && (!Number.isFinite(body.friction) || body.friction < 0 || body.friction > 1e6)) {
    throw new RangeError(`${entity.id} body.friction must be between 0 and 1000000`);
  }
}

function colliderFor(body: Body): RAPIER.ColliderDesc {
  const [x, y, z] = body.size;
  let collider: RAPIER.ColliderDesc;
  switch (body.shape) {
    case 'box': collider = RAPIER.ColliderDesc.cuboid(x / 2, y / 2, z / 2); break;
    case 'sphere': collider = RAPIER.ColliderDesc.ball(x / 2); break;
    case 'capsule': collider = RAPIER.ColliderDesc.capsule(Math.max(0, (y - x) / 2), x / 2); break;
  }
  collider.setFriction(body.friction ?? 0.6);
  collider.setRestitution(body.restitution ?? 0);
  if (body.mass !== undefined) collider.setMass(body.mass);
  return collider;
}

/**
 * Optional CPU/WASM physics: works in Node without a browser or GPU.
 *
 * Commands:
 * - physics:move { id, velocity: [vx, 0, vz], jump?: boolean }: persistent horizontal
 *   velocity in metres/second. The Y input is ignored; gravity and jumping own it.
 * - physics:impulse { id, impulse: [x, y, z] }: dynamic bodies only.
 * - physics:teleport { id, position: [x, y, z] }: resets velocity and jump state.
 *
 * Change a body's transform through teleport, not by mutating Entity.position.
 * A body definition is captured at spawn time; remove/re-spawn to replace its shape.
 */
export async function createRapierPlugin(options: PhysicsOptions = {}): Promise<Plugin> {
  const gravity = vector(options.gravity ?? [0, -9.81, 0], 'gravity');
  initialization ??= RAPIER.init();
  await initialization;

  return {
    id: 'physics',
    setup(world, scope) {
      const physics = new RAPIER.World(xyz(gravity));
      const bodies = new Map<string, BodyState>();
      let disposed = false;
      let queriesDirty = false;
      const service: PhysicsService = {
        inspect() {
          const grounded: Record<string, boolean> = Object.create(null);
          let characters = 0;
          for (const [id, state] of bodies) {
            if (!state.character) continue;
            characters++;
            grounded[id] = state.character.grounded;
          }
          return { bodies: bodies.size, characters, grounded };
        },
      };

      const release = () => {
        if (disposed) return;
        disposed = true;
        if (world.services.get('physics') === service) world.services.delete('physics');
        bodies.clear();
        // World.free also owns all colliders, rigid bodies and character controllers.
        physics.free();
      };
      scope.add(release);

      const synchronize = (state: BodyState) => {
        const position = state.body.translation();
        const rotation = state.body.rotation();
        state.entity.position = [position.x, position.y, position.z];
        state.entity.rotation = [rotation.x, rotation.y, rotation.z, rotation.w];
      };

      const spawn = (entity: Entity) => {
        const definition = entity.body;
        if (!definition || bodies.has(entity.id)) return;
        // JS finite values can still overflow or underflow Rapier's f32 storage.
        // Check before allocating anything so a rejected spawn is transactional.
        validatePhysicalValues(entity, definition);
        const desc = definition.type === 'fixed' ? RAPIER.RigidBodyDesc.fixed()
          : definition.type === 'dynamic' ? RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true)
            : RAPIER.RigidBodyDesc.kinematicPositionBased();
        desc.setTranslation(...entity.position);
        const [x, y, z, w] = entity.rotation;
        desc.setRotation({ x, y, z, w });
        const body = physics.createRigidBody(desc);
        let controller: RAPIER.KinematicCharacterController | undefined;
        try {
          const collider = physics.createCollider(colliderFor(definition), body);
          body.recomputeMassPropertiesFromColliders();
          const state: BodyState = { entity, body, collider, type: definition.type };
          if (definition.type === 'character') {
            const width = Math.min(definition.size[0], definition.size[2]);
            const height = definition.size[1];
            controller = physics.createCharacterController(Math.min(0.02, width * 0.05));
            controller.setUp({ x: 0, y: 1, z: 0 });
            controller.setSlideEnabled(true);
            controller.enableAutostep(Math.min(0.35, height * 0.25), Math.min(0.2, width / 2), false);
            // Rapier 0.21's snap-to-ground can slowly sink a stationary capsule into
            // a box floor. Gravity provides ground contact without that extra snap.
            controller.disableSnapToGround();
            controller.setMaxSlopeClimbAngle(Math.PI / 4);
            controller.setMinSlopeSlideAngle(Math.PI / 3);
            controller.setApplyImpulsesToDynamicBodies(true);
            controller.setCharacterMass(definition.mass ?? 80);
            state.character = { controller, velocity: [0, 0, 0], verticalVelocity: 0, jump: false, grounded: false };
          }
          bodies.set(entity.id, state);
          queriesDirty = true;
        } catch (error) {
          if (controller) physics.removeCharacterController(controller);
          physics.removeRigidBody(body);
          throw error;
        }
      };

      const remove = (entity: Entity) => {
        const state = bodies.get(entity.id);
        if (!state) return;
        if (state.character) physics.removeCharacterController(state.character.controller);
        physics.removeRigidBody(state.body);
        bodies.delete(entity.id);
        queriesDirty = true;
      };

      const target = (command: Command) => {
        if (typeof command.id !== 'string' || !command.id) throw new TypeError(`${command.type}: id must be a nonempty string`);
        const state = bodies.get(command.id);
        if (!state) throw new Error(`${command.type}: no physics body for ${command.id}`);
        return state;
      };

      try {
        if (world.services.has('physics')) throw new Error('The physics service is already registered');
        world.services.set('physics', service);
        for (const entity of world.entities.values()) spawn(entity);
        scope.add(world.events.on<Entity>('entity:spawn', spawn));
        scope.add(world.events.on<Entity>('entity:remove', remove));

        scope.add(world.registerCommand('physics:move', (command) => {
          const velocity = vector(command.velocity, 'physics:move velocity');
          if (command.jump !== undefined && typeof command.jump !== 'boolean') throw new TypeError('physics:move jump must be boolean');
          const state = target(command);
          if (!state.character) throw new Error('physics:move requires a character body');
          state.character.velocity = [velocity[0], 0, velocity[2]];
          state.character.jump ||= command.jump === true;
        }));

        scope.add(world.registerCommand('physics:impulse', (command) => {
          const impulse = vector(command.impulse, 'physics:impulse impulse');
          const state = target(command);
          if (state.type !== 'dynamic') throw new Error('physics:impulse requires a dynamic body');
          state.body.applyImpulse(xyz(impulse), true);
        }));

        scope.add(world.registerCommand('physics:teleport', (command) => {
          const position = vector(command.position, 'physics:teleport position');
          const state = target(command);
          state.body.setTranslation(xyz(position), true);
          state.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          state.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          if (state.character) {
            state.body.setNextKinematicTranslation(xyz(position));
            state.character.velocity = [0, 0, 0];
            state.character.verticalVelocity = 0;
            state.character.jump = false;
            state.character.grounded = false;
          }
          synchronize(state);
          queriesDirty = true;
          world.events.emit('entity:transform', state.entity);
        }));

        scope.add(world.addSystem({
          id: 'physics:step',
          phase: 'physics',
          update(_world, dt) {
            if (queriesDirty) {
              // Rapier 0.21 updates its broad phase during step. Refresh newly spawned,
              // removed or teleported colliders without advancing simulation time.
              physics.timestep = 0;
              physics.step();
              queriesDirty = false;
            }
            physics.timestep = dt;
            for (const state of bodies.values()) {
              const character = state.character;
              if (!character) continue;
              if (character.jump && character.grounded) {
                character.verticalVelocity = 5.5;
                character.grounded = false;
              }
              character.jump = false;
              character.verticalVelocity += gravity[1] * dt;
              const desired = {
                x: character.velocity[0] * dt,
                y: character.verticalVelocity * dt,
                z: character.velocity[2] * dt,
              };
              character.controller.computeColliderMovement(state.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
              const corrected = character.controller.computedMovement();
              character.grounded = character.controller.computedGrounded();
              if ((character.grounded && character.verticalVelocity < 0) ||
                  (character.verticalVelocity > 0 && corrected.y < desired.y - 1e-4)) {
                character.verticalVelocity = 0;
              }
              const current = state.body.translation();
              state.body.setNextKinematicTranslation({
                x: current.x + corrected.x, y: current.y + corrected.y, z: current.z + corrected.z,
              });
            }
            physics.step();
            for (const state of bodies.values()) synchronize(state);
          },
        }));
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
