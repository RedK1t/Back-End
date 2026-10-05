# RedKit Orchestrator (Back-End)

Node/Express service that gives each Supabase user their own Kali browser container (noVNC + proxy) on demand, and an authenticated gateway that is the only way into those containers.

- Control API: `:3008` — create / stop / heartbeat / status
- Data gateway: `:3009` — routes each user to their own container via signed tickets

```bash
cp template.env .env   # fill in Supabase URL/key, GATEWAY_SECRET, GROQ_API_KEY
npm install && npm start
```

See [API_DOCUMENTATION.md](API_DOCUMENTATION.md) and [DEPLOYMENT.md](DEPLOYMENT.md).
