import assert from "node:assert/strict";
import test from "node:test";

import * as browserModule from "../src/browser.ts";

interface ExtensionProviderDescriptor {
  provider: string;
  browser: string;
  transport: string;
  connectionState: string;
  connectionEpoch: string;
  target: {
    kind: string;
    profileId: string;
    tabId: number;
    windowId: number;
    identity: string;
  };
  ownership: {
    browser: string;
    context: string;
    target: string;
  };
  capabilities: {
    existingTab: boolean;
    currentTab: boolean;
    sidePanel: boolean;
    nativeMessaging: boolean;
    debugger: boolean;
  };
  protocol: {
    extensionVersion: string;
    protocolVersion: number;
  };
  correlation: {
    connectionId: string;
    policyAuthorityId: string;
  };
}

type ExtensionProviderFactory = (input: {
  browser: "chrome" | "edge";
  profileId: string;
  tabId: number;
  windowId: number;
  connectionEpoch: string;
  connectionState: "connected" | "disconnected" | "reconnecting" | "version_mismatch";
  extensionVersion: string;
  protocolVersion: number;
  connectionId: string;
  policyAuthorityId: string;
  nativeMessaging: boolean;
  debugger: boolean;
}) => ExtensionProviderDescriptor;

test("extension provider descriptor binds current-tab identity without URL retargeting (#122)", () => {
  const createDescriptor = (browserModule as unknown as {
    createExtensionProviderDescriptor?: ExtensionProviderFactory;
  }).createExtensionProviderDescriptor;

  assert.equal(typeof createDescriptor, "function", "extension provider descriptor factory must exist");

  const descriptor = createDescriptor!({
    browser: "chrome",
    profileId: "profile-a",
    tabId: 42,
    windowId: 7,
    connectionEpoch: "epoch-1",
    connectionState: "connected",
    extensionVersion: "0.1.0",
    protocolVersion: 1,
    connectionId: "bridge-123",
    policyAuthorityId: "policy-local",
    nativeMessaging: false,
    debugger: false,
  });

  assert.equal(descriptor.provider, "extension");
  assert.equal(descriptor.browser, "chrome");
  assert.equal(descriptor.transport, "extension");
  assert.equal(descriptor.connectionState, "connected");
  assert.equal(descriptor.connectionEpoch, "epoch-1");
  assert.deepEqual(descriptor.target, {
    kind: "tab",
    profileId: "profile-a",
    tabId: 42,
    windowId: 7,
    identity: "extension:chrome:profile-a:epoch-1:42",
  });
  assert.deepEqual(descriptor.ownership, {
    browser: "external",
    context: "external",
    target: "external",
  });
  assert.deepEqual(descriptor.capabilities, {
    existingTab: true,
    currentTab: true,
    sidePanel: true,
    nativeMessaging: false,
    debugger: false,
  });
  assert.deepEqual(descriptor.protocol, { extensionVersion: "0.1.0", protocolVersion: 1 });
  assert.deepEqual(descriptor.correlation, {
    connectionId: "bridge-123",
    policyAuthorityId: "policy-local",
  });

  const reconnect = createDescriptor!({
    browser: "chrome",
    profileId: "profile-a",
    tabId: 42,
    windowId: 7,
    connectionEpoch: "epoch-1",
    connectionState: "reconnecting",
    extensionVersion: "0.1.0",
    protocolVersion: 1,
    connectionId: "bridge-124",
    policyAuthorityId: "policy-local",
    nativeMessaging: false,
    debugger: false,
  });
  assert.equal(reconnect.target.identity, descriptor.target.identity, "worker reconnect must keep tab identity");

  const newBrowserSession = createDescriptor!({
    browser: "chrome",
    profileId: "profile-a",
    tabId: 42,
    windowId: 7,
    connectionEpoch: "epoch-2",
    connectionState: "connected",
    extensionVersion: "0.1.0",
    protocolVersion: 1,
    connectionId: "bridge-200",
    policyAuthorityId: "policy-local",
    nativeMessaging: false,
    debugger: false,
  });
  assert.notEqual(
    newBrowserSession.target.identity,
    descriptor.target.identity,
    "new browser session must not silently inherit an old tab identity",
  );
});