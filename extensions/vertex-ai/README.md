# Pi Vertex AI bootstrap extension

This optional extension supplies non-secret project and location defaults to Pi's native `google-vertex` provider and adds `/vertex-ai-status`. It does not replace Pi's provider, model catalog, authentication, or streaming implementation.

## Configuration

Prefer environment variables so a shared checkout stays account-independent:

```sh
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export GOOGLE_CLOUD_LOCATION="global"
gcloud auth application-default login
```

Alternatively, copy the ignored local configuration file:

```sh
cp extensions/vertex-ai/vertex-ai.config.example.json \
  extensions/vertex-ai/vertex-ai.config.json
```

Then edit the copied file. Do not commit account IDs when the repository is shared outside the team, and never commit service-account JSON, API keys, or access tokens.

Provider-scoped values saved by `/login google-vertex` take precedence, followed by existing shell variables and then the optional local file. If neither environment variables nor a local file exists, the extension remains loadable and `/vertex-ai-status` reports the missing routing configuration. Malformed local JSON is ignored and reported by that status command instead of breaking Pi startup.

Restart Pi or run `/reload`, select an available `google-vertex` model, and use `/vertex-ai-status` to inspect readiness.
