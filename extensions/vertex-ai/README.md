# Pi Vertex AI bootstrap extension

Makes Pi's built-in `google-vertex` models available with this machine's Application Default Credentials (ADC) by supplying non-secret project and location defaults at extension startup.

Pi 0.83.0 already ships `google-vertex/gemini-3.6-flash`. It was hidden from `/model` because Pi requires ADC **plus** a project and location before it marks Vertex models available. This extension fixes that configuration gap; it does not replace Pi's provider or model catalog.

The extension deliberately keeps Pi's native `google-vertex` implementation. Pi therefore retains remote catalog updates and its tested `@google/genai` streaming path, including incremental text/thinking, function calls and replay, usage accounting, cancellation, and Vertex error handling.

## Configuration

Edit `vertex-ai.config.json`:

```json
{
  "project": "your-billing-project",
  "location": "global"
}
```

Gemini 3.6 Flash is currently available through Vertex AI's `global` location. Provider-scoped values saved by `/login google-vertex` take precedence, followed by existing shell variables, then this file.

Configure either local ADC:

```bash
gcloud auth application-default login
```

or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account credentials file. The selected project must have billing and `aiplatform.googleapis.com` enabled.

If a previous `/login google-vertex` saved blank project/location values, run `/logout`, select `google-vertex`, and rely on this extension's defaults (or log in again with non-blank values). Pi gives stored provider values precedence over extension/shell defaults.

## Use

Reload Pi (`/reload`) or start a new Pi process, then select:

```text
google-vertex/gemini-3.6-flash
```

Run `/vertex-ai-status` to display authentication, routing configuration, and model availability.

CLI example:

```bash
pi --provider google-vertex --model gemini-3.6-flash --thinking low
```

## Files

- `index.ts` — supplies process-local project/location defaults and registers the status command.
- `vertex-ai.config.json` — non-secret project and location defaults.
- `package.json` — extension metadata.

The extension package stores no access token, API key, or service-account secret. If you explicitly use Pi's built-in `/login google-vertex` API-key flow, Pi stores that credential separately in `~/.pi/agent/auth.json` with restricted permissions.
