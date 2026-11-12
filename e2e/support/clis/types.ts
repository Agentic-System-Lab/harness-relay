/**
 * What the end-to-end tests know of one CLI and its fake (`e2e/fake-cli/agents/<provider>.cjs`): the
 * facts a spec branches on. Each CLI has a file of its own (`clis/<provider>.ts`), changed together
 * with its fake; `clis/all.ts` gathers them and `support/clis.ts` answers the specs' questions with them.
 */
import type { Permission, Provider } from '../../../src/shared/types';

export interface CliFacts {
  provider: Provider;
  /** The executable's name, without `.exe`: the server's default for the CLI, and the name its fake is installed under. */
  bin: string;
  /** The member name tests give it, and the fake lead agent too (its fake's `name`): a valid @mention. */
  name: string;
  /** Its name in the chat and in Settings (`PROVIDER_LABEL`). */
  label: string;
  /**
   * Whether its fake is written. One that is not says so and exits with code 2, and a test server
   * leaves the CLI not installed (unless the test's `missingClis` says otherwise).
   */
  implemented: boolean;
  /** Its version as Settings shows it (`v2.1.999`): what its fake's `--version` prints. */
  version: string;
  /**
   * What keeps it in the chat's folders below full access: its own sandbox (`own`), Harness Relay's
   * (`relay`, the open agents'), or nothing (`none`: it asks before what it may not do by itself).
   */
  sandbox: 'own' | 'relay' | 'none';
  /** The systems it runs on below full access; on the others Harness Relay runs it with full access only. */
  belowFullOn: readonly NodeJS.Platform[];
  /** Systems where nothing keeps it in its folders below full access although it runs there (Grok on Windows). */
  unconfinedOn?: readonly NodeJS.Platform[];
  /** The tool its `e2e:tool` step (a listing of the working directory) shows as in the activity. */
  listTool: string;
  /**
   * A command it asks to run (`approvals.spec.ts`): asked in a chat of `permission`, by `directive`
   * in the message, for `command`.
   */
  approve: { permission: Permission; directive: string; command: string };
  /** What it does with the note the user declines a request with: passes it on to the model, drops it, or ends its turn. */
  decline: 'passed' | 'dropped' | 'ends-turn';
  /** In a read-only chat, whether a write asks the user first (a card to decline) rather than being refused without one. */
  readOnlyWriteAsks: boolean;
  /** In edit mode, a write outside the chat's folders: whether it asks first, and whether it is written once the user allows it. */
  outsideWrite: { asks: boolean; writtenOnceAllowed: boolean };
  /** In edit mode, whether a write in another of the chat's working directories asks first. */
  otherCwdWriteAsks: boolean;
  /** Whether it is given the tool library's HTTP MCP servers (else stdio ones only). */
  mcpHttp: boolean;
  /** Whether a prompt's images reach it. */
  images: boolean;
  /** For `models.spec.ts`: a model to pick for a member in Team settings, and an effort it offers for that model. */
  pickModel: { model: string; effort: string };
  /** Its default account's home in a test server: a folder under the test's home folder (`home`) or data folder (`data`). */
  defaultHome: { in: 'home' | 'data'; path: readonly string[] };
  /**
   * Its accounts besides the default one: each signs in on its own (`sign-in`), signs in with an API
   * key only (`key-only`), or there are none (`none`: the open agents run on the model backends).
   */
  accounts: 'sign-in' | 'key-only' | 'none';
  /** The variable an API key reaches it in, the server's own environment's too (Codex: one of two); none for the open agents. */
  apiKeyEnv?: string;
  /** The placeholder of an account's API key box in Settings. */
  apiKeyPlaceholder?: string;
}
