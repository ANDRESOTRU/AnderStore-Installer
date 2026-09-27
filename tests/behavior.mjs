import test from "node:test";
import assert from "node:assert/strict";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

export function registerBehaviorTests({ ActivityGate, UpdateController, createReceipt, withReceipt, completeInstallation, readReceipts }) {
  function fixture(overrides = {}) {
    const calls = { checks: 0, downloads: 0, installs: 0, restarts: 0, closes: 0 };
    const gate = new ActivityGate();
    const handle = {
      version: "2.3.7", currentVersion: "2.3.6",
      async download(progress) {
        calls.downloads++;
        progress({ event: "Started", data: { contentLength: 200 } });
        progress({ event: "Progress", data: { chunkLength: 100 } });
        progress({ event: "Progress", data: { chunkLength: 100 } });
        progress({ event: "Finished" });
      },
      async install() { calls.installs++; },
      async close() { calls.closes++; },
      ...overrides,
    };
    const controller = new UpdateController({
      async check() { calls.checks++; return handle; },
      async relaunch() { calls.restarts++; },
    }, gate);
    return { calls, gate, handle, controller };
  }
  test("background check offers update without downloading; Later keeps installed app usable", async () => {
    const { controller, calls } = fixture();
    await controller.check();
    assert.equal(controller.getSnapshot().phase, "available");
    assert.equal(calls.downloads, 0);
    controller.dismiss();
    assert.equal(controller.getSnapshot().visible, false);
    await controller.check(true);
    assert.equal(controller.getSnapshot().visible, true);
    assert.equal(calls.closes, 1);
  });
  test("current version is quiet on startup and visible on manual check", async () => {
    const controller = new UpdateController({ check: async () => null, relaunch: async () => {} }, new ActivityGate());
    await controller.check();
    assert.equal(controller.getSnapshot().phase, "current");
    assert.equal(controller.getSnapshot().visible, false);
    await controller.check(true);
    assert.equal(controller.getSnapshot().visible, true);
  });
  test("offline check reports details and retry recovers", async () => {
    let offline = true;
    const controller = new UpdateController({ check: async () => { if (offline) throw new Error("offline"); return null; }, relaunch: async () => {} }, new ActivityGate());
    await controller.check(true);
    assert.equal(controller.getSnapshot().phase, "error");
    assert.match(controller.getSnapshot().error, /offline/);
    offline = false;
    await controller.check(true);
    assert.equal(controller.getSnapshot().phase, "current");
  });
  test("duplicate checks make only one request", async () => {
    const wait = deferred(); let count = 0;
    const controller = new UpdateController({ check: () => { count++; return wait.promise; }, relaunch: async () => {} }, new ActivityGate());
    const first = controller.check();
    await controller.check(true);
    assert.equal(count, 1);
    wait.resolve(null); await first;
    assert.equal(controller.getSnapshot().visible, true);
  });
  test("progress is accumulated; installation precedes restart", async () => {
    const { controller, calls, gate } = fixture();
    const phases = [];
    controller.subscribe(() => phases.push(controller.getSnapshot().phase));
    await controller.check(); await controller.install();
    assert.equal(controller.getSnapshot().downloaded, 200);
    assert.equal(controller.getSnapshot().total, 200);
    assert.equal(calls.installs, 1); assert.equal(calls.restarts, 1);
    assert.ok(phases.indexOf("downloading") < phases.indexOf("installing"));
    assert.equal(gate.getSnapshot(), null);
  });
  test("unknown and zero content lengths never manufacture a percentage", async () => {
    for (const length of [undefined, 0]) {
      const { controller } = fixture({ download: async (progress) => {
        progress({ event: "Started", data: { contentLength: length } });
        progress({ event: "Progress", data: { chunkLength: 80 } });
      } });
      await controller.check(); await controller.install();
      assert.equal(controller.getSnapshot().total, undefined);
      assert.equal(controller.getSnapshot().downloaded, 80);
    }
  });
  test("login, pairing and phone installation prevent PC update", async () => {
    for (const operation of ["login_new", "set_selected_device", "install_sidestore"]) {
      const { controller, calls, gate } = fixture();
      await controller.check();
      const wait = deferred(); const work = gate.run(operation, () => wait.promise);
      await controller.install(); assert.equal(calls.downloads, 0);
      wait.resolve(); await work;
      await controller.install(); assert.equal(calls.downloads, 1);
    }
  });
  test("updating excludes phone operations and duplicate installations", async () => {
    const wait = deferred();
    const { controller, gate, calls } = fixture({ download: () => { calls.downloads++; return wait.promise; } });
    await controller.check(); const first = controller.install();
    assert.equal(gate.getSnapshot(), "update");
    await assert.rejects(gate.run("login_new", async () => {}), /still running/);
    await controller.install(); await controller.check(true);
    assert.equal(calls.downloads, 1); assert.equal(calls.checks, 1);
    wait.resolve(); await first;
  });
  for (const stage of ["download", "install"]) test(`${stage} failure releases lock and never restarts`, async () => {
    const { controller, calls, gate } = fixture({ [stage]: async () => { throw new Error(stage === "download" ? "invalid signature" : "installer failed"); } });
    await controller.check(); await controller.install();
    assert.equal(controller.getSnapshot().phase, "error");
    assert.equal(calls.restarts, 0); assert.equal(gate.getSnapshot(), null);
  });
  test("receipt snapshots preserve the installing account for two different phones", async () => {
    const phone = { udid: "phone-a", name: "iPhone A", version: "18.0" };
    const snapshot = createReceipt(phone, "first@example.com");
    const wait = deferred(); const pending = completeInstallation(snapshot, () => wait.promise);
    phone.udid = "phone-b"; snapshot.appleId = "changed@example.com";
    wait.resolve(); const first = await pending;
    const second = await completeInstallation(createReceipt(phone, "second@example.com"), async () => {});
    const saved = withReceipt(withReceipt({}, first), second);
    assert.equal(saved["phone-a"].appleId, "first@example.com");
    assert.equal(saved["phone-b"].appleId, "second@example.com");
    const restored = JSON.parse(JSON.stringify(saved));
    assert.deepEqual(restored, saved);
    assert.deepEqual(Object.keys(first).sort(), ["appleId", "deviceId", "deviceName", "installedAt", "iosVersion"].sort());
  });
  test("failed installation leaves the previous receipt untouched", async () => {
    const snapshot = createReceipt({ udid: "phone-a", name: "A", version: "16.0" }, "old@example.com");
    const saved = withReceipt({}, snapshot);
    await assert.rejects(completeInstallation({ ...snapshot, appleId: "new@example.com" }, async () => { throw new Error("pairing failed"); }));
    assert.equal(saved["phone-a"].appleId, "old@example.com");
  });
  test("damaged saved data is skipped and only receipt fields are restored", () => {
    const receipt = createReceipt({ udid: "a", name: "A", version: "16" }, "one@example.com");
    assert.deepEqual(readReceipts(null), {});
    assert.deepEqual(readReceipts({ a: { ...receipt, installedAt: "invalid" } }), {});
    assert.deepEqual(readReceipts({ a: { ...receipt, password: "not-a-receipt-field" }, b: "broken" }), { a: receipt });
  });
}
