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

test('device-only updates initialize selected devices when ready and ignore subsequent updates', async (t) => {
  const device = new FakeDevice({ id: 'lamp', name: 'Test lamp', ready: false });
  const { server, devices, endpoints, initialized } = makeServer(t, { lamp: device });

  await server.start();
  t.after(async () => { await server.stop(); });
  assert.deepEqual(endpoints, ['lamp']);
  assert.deepEqual(initialized, []);

  assert.doesNotThrow(() => { device.emit('update', {}); });
  devices.emit('device.update', { id: 'lamp', ready: true }); // manager events are not consumed
  assert.deepEqual(initialized, []);

  device.ready = true;
  assert.doesNotThrow(() => { device.emit('update', { ready: true }); });
  assert.deepEqual(initialized, ['lamp']);

  device.__update({ name: 'Renamed lamp' });
  device.__update({ ready: false });
  device.__update({ ready: true });
  assert.deepEqual(initialized, ['lamp']);
  assert.deepEqual(endpoints, ['lamp']);
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
