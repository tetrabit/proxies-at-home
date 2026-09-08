# Optional release-notes provider

Automatic release-note generation is disabled by default. The release workflow always retains its manual-entry and skip paths.

To enable a provider, configure all three variables before starting `scripts/release.mjs`:

```sh
export RELEASE_NOTES_PROVIDER_COMMAND="/absolute/path/to/release-notes-provider"
export RELEASE_NOTES_PROVIDER_ARGS='["generate","--format","markdown"]'
export RELEASE_NOTES_PROVIDER_EXPECTED_VERSION='provider 1.2.3'
```

`RELEASE_NOTES_PROVIDER_COMMAND` must be an absolute local executable path. The script runs that executable with the configured arguments plus `--version` first, and only sends release data when its trimmed stdout exactly matches `RELEASE_NOTES_PROVIDER_EXPECTED_VERSION`.

The provider is launched directly with an argument array; no shell, package manager, download, or credential inspection is used. On a timeout, cancellation, startup error, version mismatch, oversized output, or provider failure, automatic generation returns no notes and the release script prompts for manual notes instead. On Unix, timeout and cancellation first terminate the provider's detached process group, then issue `SIGKILL` after a short grace period before returning the manual fallback.

The configured executable receives the generated prompt on standard input. It must write the notes to standard output and should treat standard error as diagnostic output.
