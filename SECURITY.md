# Security

## Reporting

Report a vulnerability privately through GitHub's **Report a vulnerability** button on the
Security tab. Please do not open a public issue for anything exploitable.

## What is, and is not, in this repository

This is the application source. It contains **no keys and no credentials**, and it never should.
Everything that can sign or spend is read from the environment at runtime and held as a deployment
secret:

| Variable | What it is |
|---|---|
| `FEE_CLAIMER_KEY` | base58 secret key for the wallet that claims pool fees and pays holders |
| `RPC_URL` | RPC endpoint, which usually carries an API key |
| `AI_API_KEY` | optional; the hourly dividend-asset picker |

If you are deploying your own instance, set these as secrets in your host — never in a file in the
repository, and never in `fly.toml` or a Dockerfile, both of which are committed.
