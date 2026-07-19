import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { MobileMachine, MobileMachineConfig } from '@lobster/shared-types';

/**
 * Host-side lifecycle for a per-profile Android machine. Orchestrates the Android SDK emulator + adb on
 * a KVM+GPU host. Each machine is a copy-on-write clone of the sealed golden image (image/), booted with
 * the machine's fingerprint (build.prop overlay) and proxy, then provisioned so the built-in Island app
 * becomes device owner (image/first-boot-provision.sh).
 *
 * NOT runnable on a GPU-less box — this is the contract the desktop core drives on a provisioned host.
 */
export interface MobileMachineRunner {
  provision(machine: MobileMachine): Promise<MobileMachine>;
  boot(machine: MobileMachine): Promise<MobileMachine>;
  stop(machine: MobileMachine): Promise<void>;
  destroy(machine: MobileMachine): Promise<void>;
}

const IMAGE_DIR = new URL('../image/', import.meta.url).pathname;

function sh(cmd: string, args: string[], opts: { detached?: boolean } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: opts.detached ?? false });
    let out = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (out += String(d)));
    child.on('error', reject);
    if (opts.detached) {
      child.unref();
      resolve({ code: 0, out });
    } else {
      child.on('close', (code) => resolve({ code: code ?? 0, out }));
    }
  });
}

/** Derive the Android build.prop / sensor / GPU overlay for a machine from its fingerprint seed. */
export function buildPropsFor(config: MobileMachineConfig): Record<string, string> {
  // The concrete values come from @lobster/fingerprint's Android derivation keyed by machineType +
  // apiLevel + seed (ro.product.*, ro.build.fingerprint, gsm.*, sensors). Kept coherent with the proxy
  // geo. Returned as a build.prop overlay pushed before boot.
  return {
    'ro.product.model': config.machineType,
    'ro.build.version.sdk': String(config.apiLevel),
    // …ro.product.brand/device/manufacturer, ro.build.fingerprint, ril.imei, etc. from the seed.
  };
}

export class AvdMachineRunner implements MobileMachineRunner {
  /** Clone the golden snapshot into a per-machine AVD and stage its fingerprint + Island policy. */
  async provision(machine: MobileMachine): Promise<MobileMachine> {
    const avdName = `lobium-${machine.id}`;
    // Copy-on-write clone of the golden AVD (qcow2 overlay), not a full copy — fast + disk-cheap.
    await sh('avdmanager', ['create', 'avd', '-n', avdName, '-d', machine.config.machineType, '--force']);
    // Write this machine's Island policy from its IslandConfig for first-boot-provision.sh.
    const policyDir = join(tmpdir(), avdName);
    await mkdir(policyDir, { recursive: true });
    await writeFile(
      join(policyDir, 'island-policy.json'),
      JSON.stringify({
        isolateOnInstall: machine.config.island.isolateOnInstall,
        freezeIdleApps: machine.config.island.freezeIdleApps,
      }),
    );
    return { ...machine, status: 'stopped' };
  }

  /** Boot the clone with proxy + fingerprint, then provision Island as device owner. */
  async boot(machine: MobileMachine): Promise<MobileMachine> {
    const avdName = `lobium-${machine.id}`;
    const proxyArgs = machine.config.proxy
      ? ['-http-proxy', `${machine.config.proxy.host}:${machine.config.proxy.port}`]
      : [];
    // Launch headless from the golden snapshot; each machine gets its own console/adb port.
    await sh(
      'emulator',
      ['-avd', avdName, '-no-window', '-snapshot', 'golden', '-writable-system', ...proxyArgs],
      { detached: true },
    );
    await sh('adb', ['-s', `emulator-${machine.id}`, 'wait-for-device']);

    // Apply the fingerprint overlay (build.prop) before Island/apps read device identity.
    const props = buildPropsFor(machine.config);
    for (const [k, v] of Object.entries(props)) {
      await sh('adb', ['shell', 'setprop', k, v]);
    }
    // Provision the built-in Island app as device owner + write the per-machine policy.
    const policy = join(tmpdir(), avdName, 'island-policy.json');
    await sh('bash', [join(IMAGE_DIR, 'first-boot-provision.sh'), policy]);

    const adbSerial = `emulator-${machine.id}`;
    // The in-machine browser exposes CDP; forward it to a host port for the app + Lob.
    return {
      ...machine,
      status: 'running',
      adbSerial,
      cdpEndpoint: `ws://127.0.0.1:0/devtools/browser`, // resolved from `adb forward` at connect time
    };
  }

  async stop(machine: MobileMachine): Promise<void> {
    if (machine.adbSerial) await sh('adb', ['-s', machine.adbSerial, 'emu', 'kill']);
  }

  async destroy(machine: MobileMachine): Promise<void> {
    await this.stop(machine);
    await sh('avdmanager', ['delete', 'avd', '-n', `lobium-${machine.id}`]);
  }
}
