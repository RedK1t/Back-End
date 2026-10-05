<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/RedK1t/RedKit/main/docs/assets/logo-light.svg">
    <img src="https://raw.githubusercontent.com/RedK1t/RedKit/main/docs/assets/logo-dark.svg" alt="RedKit" width="96">
  </picture>
</p>

<h1 align="center">RedKit Orchestrator</h1>

<p align="center">Per-user Kali browser containers, behind an authenticated gateway.<br>
Part of <a href="https://github.com/RedK1t/RedKit"><b>RedKit</b></a>, a modular, web-based penetration-testing framework.</p>

---

Node/Express service that gives each Supabase user their own Kali browser container (noVNC + proxy) on demand, and an authenticated gateway that is the only way into those containers.

- Control API: `:3008` — create / stop / heartbeat / status
- Data gateway: `:3009` — routes each user to their own container via signed tickets

```bash
cp template.env .env   # fill in Supabase URL/key, GATEWAY_SECRET, GROQ_API_KEY
npm install && npm start
```

See [API_DOCUMENTATION.md](API_DOCUMENTATION.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## License

[MIT](LICENSE). For authorized security testing and education only. Only scan systems you own or have written permission to test.
