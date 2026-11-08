**English** | [繁體中文](README.zh-TW.md)

# Proposals

Designs for features Harness Relay does not have yet. Nothing in this folder is implemented: the [architecture](../architecture.md) and the [developer guide](../developer-guide.md) describe the app as it is.

| Proposal | Status | Summary |
| --- | --- | --- |
| [Scheduled and event-triggered runs](triggers.md) | Not started | A conversation starts a run by itself: on a schedule, or when a local program reports an event. |
| [Shared memory across agents](shared-memory.md) | Not started | Agents suggest notes for the tool library's memory; the user accepts them. Memory per project, and importing what each CLI remembered. |

## How to use this folder

- One proposal per file, in both languages (`<name>.md` and `<name>.zh-TW.md`), changed together.
- A proposal says what exists today, what is missing, the design it recommends, the alternatives it rejected and why, and the questions still open.
- When part of a proposal is built, describe that part in the architecture and developer guide (both languages) in the same commit, and update the status here. When all of it is built, or it is dropped, delete the file and say so in the commit message.
