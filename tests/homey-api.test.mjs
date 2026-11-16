import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Server } from 'socket.io';
import { HomeyAPI } from 'homey-api';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Homey API event');
    await delay(20);
  }
}

test('homey-api 3.19.4 loads, discovers devices, and restores capability subscriptions after reconnect', { timeout: 15000 }, async () => {
  const devices = {
    lamp: {
      id: 'lamp', name: 'Test lamp', capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false, lastUpdated: '2026-01-01T00:00:00.000Z' } },
    },
  };
  const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url.includes('/devices/device') ? devices : {}));
  });
  const io = new Server(http, { allowEIO3: true, transports: ['websocket'] });
  const subscriptions = [];
  const sockets = new Set();
  io.of('/').on('connection', (socket) => {
    socket.on('handshakeClient', (request, callback) => {
      callback(null, { namespace: '/api', success: true });
    });
  });
  io.of('/api').on('connection', (socket) => {
    sockets.add(socket);
    socket.on('disconnect', () => { sockets.delete(socket); });
    socket.on('subscribe', (uri, callback) => {
      subscriptions.push(uri);
      socket.join(uri);
      callback();
    });
    socket.on('unsubscribe', (uri, callback) => { socket.leave(uri); callback(); });
    socket.on('api', (request, callback) => {
      if (request.operation === 'getDevices') callback(null, structuredClone(devices));
      else if (request.operation === 'getDevice') callback(null, structuredClone(devices.lamp));
      else callback(null, {});
    });
  });
  await new Promise((resolve) => { http.listen(0, '127.0.0.1', resolve); });

  const api = await HomeyAPI.createAppAPI({
    homey: {
      platform: 'local', platformVersion: 2, version: '13.5.1',
      api: {
        getOwnerApiToken: async () => { return 'fixture-token'; },
        getLocalUrl: async () => { return `http://127.0.0.1:${http.address().port}`; },
      },
      cloud: { getHomeyId: async () => { return 'fixture-homey'; } },
    },
  });

  let capability;
  try {
    await api.devices.connect();
    const discovered = await api.devices.getDevices();
    assert.equal(discovered.lamp.name, 'Test lamp');
    const values = [];
    capability = discovered.lamp.makeCapabilityInstance('onoff', (value) => { values.push(value); });
    const uri = 'homey:device:lamp';
    await waitFor(() => { return subscriptions.includes(uri); });
    io.of('/api').to(uri).emit(uri, 'capability', {
      capabilityId: 'onoff', value: true, transactionTime: '2026-01-01T00:00:01.000Z',
    });
    await waitFor(() => { return values.includes(true); });

    const oldCount = subscriptions.filter((entry) => { return entry === uri; }).length;
    for (const socket of sockets) socket.conn.close();
    await waitFor(() => {
      return subscriptions.filter((entry) => { return entry === uri; }).length > oldCount;
    });
    io.of('/api').to(uri).emit(uri, 'capability', {
      capabilityId: 'onoff', value: false, transactionTime: '2026-01-01T00:00:02.000Z',
    });
    await waitFor(() => { return values.at(-1) === false; });
    assert.equal(discovered.lamp.capabilitiesObj.onoff.value, false);
  } finally {
    capability?.destroy();
    await api.destroy();
    await new Promise((resolve) => { io.close(resolve); });
  }
});

test('selected-device subscription works without connecting the device manager and refreshes after reconnect', { timeout: 15000 }, async () => {
  const devices = {
    lamp: {
      id: 'lamp', name: 'Test lamp', ready: false, capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false, lastUpdated: '2026-01-01T00:00:00.000Z' } },
    },
    other: { id: 'other', name: 'Other', capabilities: [], capabilitiesObj: {} },
  };
  const operations = [];
  const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path.endsWith('/devices/device/lamp')) {
      operations.push('getDevice');
      response.end(JSON.stringify(devices.lamp));
    } else if (/\/devices\/device\/?$/.test(path)) {
      operations.push('getDevices');
      response.end(JSON.stringify(devices));
    } else {
      response.end(JSON.stringify({}));
    }
  });
  const io = new Server(http, { allowEIO3: true, transports: ['websocket'] });
  const subscriptions = [];
  const sockets = new Set();
  io.of('/').on('connection', (socket) => {
    socket.on('handshakeClient', (request, callback) => {
      callback(null, { namespace: '/api', success: true });
    });
  });
  io.of('/api').on('connection', (socket) => {
    sockets.add(socket);
    socket.on('disconnect', () => { sockets.delete(socket); });
    socket.on('subscribe', (uri, callback) => {
      subscriptions.push(uri);
      socket.join(uri);
      callback();
    });
    socket.on('unsubscribe', (uri, callback) => { socket.leave(uri); callback(); });
    socket.on('api', (request, callback) => {
      operations.push(request.operation);
      if (request.operation === 'getDevices') callback(null, structuredClone(devices));
      else if (request.operation === 'getDevice') callback(null, structuredClone(devices.lamp));
      else callback(null, {});
    });
  });
  await new Promise((resolve) => { http.listen(0, '127.0.0.1', resolve); });

  const api = await HomeyAPI.createAppAPI({
    homey: {
      platform: 'local', platformVersion: 2, version: '13.5.1',
      api: {
        getOwnerApiToken: async () => { return 'fixture-token'; },
        getLocalUrl: async () => { return `http://127.0.0.1:${http.address().port}`; },
      },
      cloud: { getHomeyId: async () => { return 'fixture-homey'; } },
    },
  });

  const server = new MatterBridgeServer({
    api, debug: () => {}, enabledDeviceIds: new Set(['lamp']), storageServiceLocation: '/nonexistent',
  });
  const readyUpdates = [];
  server.__onSelectedDeviceUpdate = (device) => { readyUpdates.push(device.ready); };

  let capability;
  try {
    const device = await server.__getSelectedDevice('lamp');
    const uri = 'homey:device:lamp';
    await waitFor(() => { return subscriptions.includes(uri); });
    assert.equal(api.devices.isConnected(), false);
    assert.ok(!subscriptions.includes('homey:manager:devices'));
    assert.ok(!operations.includes('getDevices'));

    // Device update events arrive on the device's own namespace.
    io.of('/api').to(uri).emit(uri, 'update', { ...devices.lamp, ready: true });
    await waitFor(() => { return readyUpdates.includes(true); });
    assert.equal(device.ready, true);

    const values = [];
    capability = device.makeCapabilityInstance('onoff', (value) => { values.push(value); });
    io.of('/api').to(uri).emit(uri, 'capability', {
      capabilityId: 'onoff', value: true, transactionTime: '2026-01-01T00:00:01.000Z',
    });
    await waitFor(() => { return values.includes(true); });

    // A value that changes while the socket is down is recovered by refetching only this device.
    devices.lamp.ready = true;
    devices.lamp.capabilitiesObj.onoff = { value: false, lastUpdated: '2026-01-01T00:00:05.000Z' };
    const getDeviceCount = operations.filter((op) => { return op === 'getDevice'; }).length;
    for (const socket of sockets) socket.conn.close();
    await waitFor(() => { return values.at(-1) === false; });
    assert.ok(operations.filter((op) => { return op === 'getDevice'; }).length > getDeviceCount);
    assert.ok(!operations.includes('getDevices'));
    assert.equal(device.capabilitiesObj.onoff.value, false);
    assert.equal(api.devices.isConnected(), false);
  } finally {
    capability?.destroy();
    for (const id of Object.keys(server.selectedDevices)) server.__forgetSelectedDevice(id);
    await api.destroy();
    await new Promise((resolve) => { io.close(resolve); });
  }
});
