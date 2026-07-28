import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  heroArrowRight,
  heroCheck,
  heroCommandLine,
  heroCursorArrowRays,
} from '@ng-icons/heroicons/outline';

/** The two SDK flavours offered by the local automation API. */
type SdkLanguage = 'python' | 'javascript';

/**
 * Code samples live here as plain strings rather than in the template: Angular parses `{{` and `@`
 * inside templates, and both appear in realistic SDK code. Rendering an interpolated string keeps
 * the sample verbatim and keeps the template free of escapes.
 */
const PYTHON_SAMPLE = `from lobster import LobsterClient

# The automation API is served locally by the app.
client = LobsterClient(token=LOBSTER_TOKEN)

profile = client.profiles.create(
    name="Aurora Retail",
    os="windows",
    proxy={
        "kind": "socks5",
        "host": "gw.example.net",
        "port": 1080,
    },
)

# Timezone and locale follow the proxy exit IP.
session = client.profiles.launch(profile.id)
page = session.new_page()

page.goto("https://example.com/reports")
page.wait_for_selector("#summary")
print(page.title())

session.close()`;

const JAVASCRIPT_SAMPLE = `import { LobsterClient } from '@lobster/sdk';

// The automation API is served locally by the app.
const client = new LobsterClient({
  token: process.env.LOBSTER_TOKEN,
});

const profile = await client.profiles.create({
  name: 'Aurora Retail',
  os: 'windows',
  proxy: {
    kind: 'socks5',
    host: 'gw.example.net',
    port: 1080,
  },
});

// Timezone and locale follow the proxy exit IP.
const session = await client.profiles.launch(profile.id);
const page = await session.newPage();

await page.goto('https://example.com/reports');
await page.waitForSelector('#summary');
console.log(await page.title());

await session.close();`;

@Component({
  selector: 'app-automation-section',
  imports: [RouterLink, NgIcon],
  viewProviders: [
    provideIcons({ heroArrowRight, heroCheck, heroCommandLine, heroCursorArrowRays }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './automation-section.html',
})
export class AutomationSection {
  protected readonly tab = signal<SdkLanguage>('python');

  protected readonly tabs = [
    { id: 'python', label: 'Python' },
    { id: 'javascript', label: 'JavaScript' },
  ] as const;

  protected readonly capabilities = [
    {
      id: 'api',
      title: 'Local automation API',
      body: 'Start, stop and drive profiles from your own code, on the machine the engine runs on.',
    },
    {
      id: 'sdks',
      title: 'JS and Python SDKs',
      body: 'First-party clients, typed and documented, covering profiles, proxies and sessions.',
    },
    {
      id: 'lobee',
      title: 'Lobee, the in-browser agent',
      body: 'Describe a task in plain language. Lobee perceives the page and acts with humanized input — real cursor paths, human typing cadence — and adds zero automation tells.',
    },
  ] as const;

  protected readonly code = computed(() =>
    this.tab() === 'python' ? PYTHON_SAMPLE : JAVASCRIPT_SAMPLE,
  );

  protected readonly filename = computed(() =>
    this.tab() === 'python' ? 'launch_profile.py' : 'launch-profile.mjs',
  );
}
