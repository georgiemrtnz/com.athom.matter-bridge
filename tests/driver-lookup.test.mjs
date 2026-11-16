import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Environment, Logger } from '@matter/main';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

Logger.level = 'error';

// Regression: with the driver manager no longer cached, device.getDriver() is a live
// request. A transient failure must not drop the bridged endpoint, or Apple Home
// loses the accessory. Driver lookups are also shared per driverId.
test('a failing driver lookup still creates the endpoint, and drivers are fetched once per driverId', { timeout: 30000 }, async (t) => {
  let driverCalls = 0;
  const makeDevice = (id, driverId, fail) => ({
    id, name: id, class: 'socket', ready: true, driverId,
    capabilitiesObj: { onoff: { value: true } },
    getDriver: async () => {
      driverCalls += 1;
      if (fail) throw new Error('socket hang up');
      return { name: 'Plug', ownerName: 'Vendor' };
    },
    makeCapabilityInstance: () => ({ destroy: () => {} }),
    setCapabilityValue: async () => {},
  });
  const devicesById = {
    broken: makeDevice('broken', 'homey:app:x:broken', true),
    plugA: makeDevice('plugA', 'homey:app:x:plug', false),
    plugB: makeDevice('plugB', 'homey:app:x:plug', false),
  };
  const devices = new EventEmitter();
  devices.getDevice = async ({ id }) => devicesById[id];
  const directory = await mkdtemp(join(tmpdir(), 'matter-driver-lookup-'));
  const bridge = new MatterBridgeServer({
    api: { devices },
    debug: () => {},
    deviceName: 'Test bridge', vendorName: 'Test', vendorId: 65521,
    productName: 'Test bridge', productId: 32768, uniqueId: 'driver-lookup-test', serialNumber: 'test',
    passcode: 20202021, discriminator: 1709, port: 0,
    storageServiceLocation: directory,
    enabledDeviceIds: new Set(Object.keys(devicesById)),
  });
  t.after(async () => {
    await bridge.stop();
    await Environment.default.runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  await bridge.start();

  for (const id of Object.keys(devicesById)) {
    assert.ok(bridge.deviceEndpoints[id], `${id} has a bridged endpoint`);
    assert.ok(bridge.deviceEndpointInstances[id]?.size > 0, `${id} is initialized`);
  }
  assert.equal(bridge.deviceEndpoints.broken.state.bridgedDeviceBasicInformation.vendorName, 'Unknown');
  assert.equal(bridge.deviceEndpoints.plugB.state.bridgedDeviceBasicInformation.vendorName, 'Vendor');
  assert.equal(driverCalls, 2, 'one call for the failing driver, one shared by both plugs');
});
