import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ServerNode } from '@matter/main';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

class FakeDevice extends EventEmitter {
  constructor(props) {
    super();
    Object.assign(this, props);
    this.connectCalls = 0;
    this.destroyed = false;
  }

  async connect() { this.connectCalls += 1; }

  destroy() { this.destroyed = true; this.removeAllListeners(); }

  __update(props) { Object.assign(this, props); this.emit('update', props); }
}

function makeServer(t, devicesById, { enabled = Object.keys(devicesById) } = {}) {
  const calls = { getDevice: [], managerConnect: 0, getDevices: 0, driversConnect: 0 };
  const devices = new EventEmitter();
  devices.connect = async () => { calls.managerConnect += 1; };
  devices.getDevices = async () => { calls.getDevices += 1; return devicesById; };
  devices.getDevice = async ({ id }) => {
    calls.getDevice.push(id);
    const device = devicesById[id];
    if (device instanceof Error) throw device;
    if (!device) throw Object.assign(new Error('Not Found: Device with ID ' + id), { statusCode: 404 });
    return device;
  };
  const server = new MatterBridgeServer({
    api: {
      devices,
      drivers: { connect: async () => { calls.driversConnect += 1; }, getDrivers: async () => { return {}; } },
    },
    debug: () => {},
    enabledDeviceIds: new Set(enabled),
  });
  t.mock.method(ServerNode, 'create', async () => {
    return { add: async () => {}, start: async () => {}, close: async () => {} };
  });
  const endpoints = [];
  const initialized = [];
  const uninitialized = [];
  t.mock.method(server, '__initEndpoint', async (device) => {
    endpoints.push(device.id);
    server.deviceEndpoints[device.id] = {};
  });
  t.mock.method(server, '__initDevice', async (device) => {
    initialized.push(device.id);
    server.deviceEndpointInstances[device.id] = new Set();
  });
  t.mock.method(server, '__uninitEndpoint', async (device) => {
    uninitialized.push(device.id);
    delete server.deviceEndpoints[device.id];
    delete server.deviceEndpointInstances[device.id];
  });
  return { server, devices, calls, endpoints, initialized, uninitialized };
}

test('startup fetches only selected devices and never connects the device or driver managers', async (t) => {
  const lamp = new FakeDevice({ id: 'lamp', name: 'Lamp', ready: true });
  const other = new FakeDevice({ id: 'other', name: 'Other', ready: true });
  const { server, calls, endpoints, initialized } = makeServer(t, { lamp, other }, { enabled: ['lamp'] });

  await server.start();
  t.after(async () => { await server.stop(); });

  assert.deepEqual(calls.getDevice, ['lamp']);
  assert.equal(calls.managerConnect, 0);
  assert.equal(calls.driversConnect, 0);
  assert.equal(calls.getDevices, 0);
  assert.deepEqual(endpoints, ['lamp']);
  assert.deepEqual(initialized, ['lamp']);
  assert.equal(lamp.connectCalls, 1);
  assert.equal(other.connectCalls, 0);
  assert.equal(other.listenerCount('update'), 0);
});

const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };

// getDevice returns a fresh plain snapshot each call, as the real API does; the
// fake item itself never emits 'update' on its own (Homey announces readiness on
// the manager namespace, which the bridge does not subscribe to).
function serveSnapshots(devices, calls, snapshots) {
  devices.getDevice = async ({ id }) => {
    calls.getDevice.push(id);
    return snapshots[id]();
  };
}

test('readiness from an item update attaches once; unrelated updates do not re-attach', async (t) => {
  const device = new FakeDevice({ id: 'lamp', name: 'Test lamp', ready: false });
  const { server, endpoints, initialized } = makeServer(t, { lamp: device });

  await server.start();
  t.after(async () => { await server.stop(); });
  assert.deepEqual(endpoints, ['lamp']);
  assert.deepEqual(initialized, []);

  device.__update({});
  assert.deepEqual(initialized, []);

  device.__update({ ready: true });
  assert.deepEqual(initialized, ['lamp']);

  device.__update({ name: 'Renamed lamp' });
  device.__update({ ready: true });
  assert.deepEqual(initialized, ['lamp']);
  assert.deepEqual(endpoints, ['lamp']);
});

test('a device not ready at start is attached by the 30 s re-check without any item event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = new FakeDevice({ id: 'lamp', name: 'Lamp', ready: false });
  const { server, devices, calls, endpoints, initialized } = makeServer(t, { lamp: device });
  let ready = false;
  serveSnapshots(devices, calls, { lamp: () => ({ id: 'lamp', name: 'Lamp', ready, capabilitiesObj: {} }) });
  // The first read (startup) returns the subscribed item; later reads are snapshots.
  const firstGet = devices.getDevice;
  devices.getDevice = async (args) => (calls.getDevice.length === 0 ? (calls.getDevice.push(args.id), device) : firstGet(args));

  await server.start();
  t.after(async () => { await server.stop(); });
  assert.deepEqual(endpoints, ['lamp']);
  assert.ok(server.deviceEndpoints.lamp);
  assert.equal(server.deviceEndpointInstances.lamp, undefined);
  assert.ok(server.__pendingInitTimer, 'a re-check is scheduled');

  // Still not ready at the first re-check: reschedules.
  t.mock.timers.tick(30000); await flush();
  assert.deepEqual(calls.getDevice, ['lamp', 'lamp']);
  assert.deepEqual(initialized, []);

  ready = true;
  t.mock.timers.tick(30000); await flush();
  assert.deepEqual(calls.getDevice, ['lamp', 'lamp', 'lamp']);
  assert.deepEqual(initialized, ['lamp']);
  assert.ok(server.deviceEndpointInstances.lamp);
  assert.equal(server.__pendingInitTimer, null, 'the re-check stops once attached');

  t.mock.timers.tick(30000); await flush();
  assert.deepEqual(calls.getDevice, ['lamp', 'lamp', 'lamp']);
  assert.equal(calls.managerConnect, 0);
  assert.equal(calls.getDevices, 0);
});

test('a device selected while not ready is attached by the re-check', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lamp = new FakeDevice({ id: 'lamp', name: 'Lamp', ready: true });
  const blind = new FakeDevice({ id: 'blind', name: 'Blind', ready: false });
  const { server, devices, calls, initialized } = makeServer(t, { lamp, blind }, { enabled: ['lamp'] });

  await server.start();
  t.after(async () => { await server.stop(); });
  assert.equal(server.__pendingInitTimer, null, 'nothing pending while all devices are attached');

  await server.enableDevice('blind');
  assert.deepEqual(initialized, ['lamp']);
  assert.ok(server.__pendingInitTimer);

  let ready = true;
  serveSnapshots(devices, calls, { blind: () => ({ id: 'blind', name: 'Blind', ready, capabilitiesObj: {} }) });
  t.mock.timers.tick(30000); await flush();
  assert.deepEqual(initialized, ['lamp', 'blind']);
  assert.equal(server.__pendingInitTimer, null);
  ready = false;
});

test('stop clears a pending re-check so nothing runs after close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = new FakeDevice({ id: 'lamp', name: 'Lamp', ready: false });
  const { server, calls } = makeServer(t, { lamp: device });

  await server.start();
  assert.ok(server.__pendingInitTimer);
  const before = calls.getDevice.length;
  await server.stop();
  assert.equal(server.__pendingInitTimer, null);

  t.mock.timers.tick(120000); await flush();
  assert.equal(calls.getDevice.length, before);
  server.__schedulePendingInit();
  assert.equal(server.__pendingInitTimer, null, 'no re-check is scheduled once stopped');
});

test('ready -> not ready -> ready keeps endpoints and bindings (Apple Home never sees a change)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = new FakeDevice({ id: 'lamp', name: 'Lamp', ready: true });
  const { server, devices, calls, endpoints, initialized, uninitialized } = makeServer(t, { lamp: device });
  const destroyed = [];
  const childDeleted = [];

  await server.start();
  t.after(async () => { await server.stop(); });
  assert.deepEqual(initialized, ['lamp']);
  const children = new Set([{ delete: async () => { childDeleted.push('main'); } }]);
  server.deviceEndpointInstances.lamp = children;
  server.deviceCapabilityInstances.lamp = { onoff: { destroy: () => { destroyed.push('onoff'); } } };
  const bridgedEndpoint = server.deviceEndpoints.lamp;

  // Backing app restarts: the device reports not ready.
  device.__update({ ready: false });
  await flush();
  assert.deepEqual(destroyed, [], 'capability bindings are kept');
  assert.deepEqual(childDeleted, [], 'child endpoints are kept');
  assert.equal(server.deviceEndpointInstances.lamp, children);
  assert.equal(server.deviceEndpoints.lamp, bridgedEndpoint);
  assert.deepEqual(uninitialized, []);
  assert.ok(server.__pendingInitTimer, 'a re-check refreshes the device once it is ready');

  // Still not ready at the first re-check: keep re-checking.
  serveSnapshots(devices, calls, { lamp: () => ({ id: 'lamp', name: 'Lamp', ready: false, capabilitiesObj: {} }) });
  t.mock.timers.tick(30000); await flush();
  assert.ok(server.__pendingInitTimer);

  serveSnapshots(devices, calls, { lamp: () => ({ id: 'lamp', name: 'Lamp', ready: true, capabilitiesObj: {} }) });
  t.mock.timers.tick(30000); await flush();
  assert.equal(device.ready, true);
  assert.deepEqual(initialized, ['lamp'], 'no re-attach: bindings were never removed');
  assert.deepEqual(endpoints, ['lamp']);
  assert.deepEqual(destroyed, []);
  assert.deepEqual(childDeleted, []);
  assert.equal(server.__pendingInitTimer, null, 'timer stops once all devices are ready');
  assert.equal(calls.getDevices, 0);
  assert.equal(calls.managerConnect, 0);
});

test('a flapping not-ready/ready device is never re-attached or duplicated', async (t) => {
  const device = new FakeDevice({ id: 'lamp', name: 'Lamp', ready: true });
  const { server, initialized, uninitialized } = makeServer(t, { lamp: device });
  await server.start();
  t.after(async () => { await server.stop(); });

  device.__update({ ready: false });
  device.__update({ ready: true });
  device.__update({ ready: false });
  device.__update({ ready: true });
  await flush();
  assert.deepEqual(initialized, ['lamp']);
  assert.deepEqual(uninitialized, []);
});

test('a missing selected device is skipped; other fetch errors fail startup', async (t) => {
  const lamp = new FakeDevice({ id: 'lamp', name: 'Lamp', ready: true });
  const first = makeServer(t, { lamp }, { enabled: ['gone', 'lamp'] });
  await first.server.start();
  assert.deepEqual(first.endpoints, ['lamp']);
  await first.server.stop();

  const second = makeServer(t, { lamp: new Error('Timeout after 30000ms') }, { enabled: ['lamp'] });
  await assert.rejects(second.server.start(), /Timeout/);
});

test('a newly selected device is fetched, subscribed and bridged; disabling releases it', async (t) => {
  const lamp = new FakeDevice({ id: 'lamp', name: 'Lamp', ready: true });
  const blind = new FakeDevice({ id: 'blind', name: 'Blind', ready: true });
  const { server, calls, endpoints, initialized, uninitialized } = makeServer(t, { lamp, blind }, { enabled: ['lamp'] });

  await server.start();
  t.after(async () => { await server.stop(); });

  await server.enableDevice('blind');
  assert.deepEqual(calls.getDevice, ['lamp', 'blind']);
  assert.deepEqual(endpoints, ['lamp', 'blind']);
  assert.deepEqual(initialized, ['lamp', 'blind']);
  assert.equal(blind.connectCalls, 1);
  assert.ok(server.enabledDeviceIds.has('blind'));
  assert.equal(calls.managerConnect, 0);

  await server.disableDevice('blind');
  assert.deepEqual(uninitialized, ['blind']);
  assert.equal(blind.destroyed, true);
  assert.equal(server.selectedDevices.blind, undefined);
  assert.equal(server.enabledDeviceIds.has('blind'), false);

  await assert.rejects(server.enableDevice('missing'), /not found/);
  assert.equal(server.enabledDeviceIds.has('missing'), false);
});

test('a device delete event removes only that endpoint', async (t) => {
  const lamp = new FakeDevice({ id: 'lamp', name: 'Lamp', ready: true });
  const blind = new FakeDevice({ id: 'blind', name: 'Blind', ready: true });
  const { server, uninitialized } = makeServer(t, { lamp, blind });

  await server.start();
  t.after(async () => { await server.stop(); });

  lamp.emit('delete');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(uninitialized, ['lamp']);
  assert.equal(server.selectedDevices.lamp, undefined);
  assert.ok(server.selectedDevices.blind);
});

test('stop releases all device subscriptions', async (t) => {
  const lamp = new FakeDevice({ id: 'lamp', name: 'Lamp', ready: true });
  const { server } = makeServer(t, { lamp });
  await server.start();
  await server.stop();
  assert.equal(lamp.destroyed, true);
  assert.deepEqual(server.selectedDevices, {});
});
