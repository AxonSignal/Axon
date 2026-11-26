<p align="center"><img src="public/pp.png" width="140" alt="AXON"></p>

<h1 align="center">AXON</h1>
<p align="center"><b>Memory in. Signal out.</b><br>One encrypted memory for every AI you use, and a Signal that answers as you.<br>Every read is sealed on Robinhood Chain.</p>

<p align="center"><a href="https://axonsignal.fun">axonsignal.fun</a> · <a href="https://axonsignal.fun/app?demo=1">Try the demo vault</a> · <a href="https://axonsignal.fun/s/nora">Talk to a live Signal</a></p>

---

## What AXON does

Every AI app keeps its own memory of you, locked inside it. AXON flips that around. You keep one vault of what your AIs should know about you, split into folders, and you decide which app may read which folder.

- **Vault.** Write memories, sort them in folders, keep a self card, import your ChatGPT or Claude history.
- **Apps.** Give Claude, Cursor or any MCP client its own key and only the folders you tick. Revoke it and its next request fails.
- **Inbox.** Connected apps can suggest new memories. Nothing is added until you keep it.
- **Signal.** Publish the folders you are happy to make public and get a page where anyone can ask you questions. An AI answers in your words, only from those folders.
- **Seals.** Every read, by an app or by your Signal, is logged. Each hour the reads are folded into one Merkle root and written to Robinhood Chain. You can prove any read of yours is in it without revealing anyone else's.

## How the encryption works

Nothing readable leaves your browser.

1. You sign one fixed message with your wallet. HKDF turns that signature into two values: an **auth token** sent to the server, and a **master key** that never leaves the browser.
2. Each folder has its own random AES-256-GCM key, wrapped with the master key. Folder names and memories are encrypted with the folder key.
3. An app key is a random secret. It derives its own auth token and a **wrap key**. Granting a folder means wrapping that folder's key with the app's wrap key. The server stores only wrapped keys and ciphertext.
4. Suggestions from apps are encrypted to the vault's inbox public key (ECDH P-256).
5. The only plaintext the server ever holds is what you publish on purpose to your Signal.

See [`public/core.js`](public/core.js) for the client crypto and [`public/axon-connector.mjs`](public/axon-connector.mjs) for the connector.

## Seals on Robinhood Chain

- Contract: [`AxonSeals`](contracts/AxonSeals.sol) at [`0x7e0b2F07d9f9A9e5b40b674A1e7dBC2471c76984`](https://robinhoodchain.blockscout.com/address/0x7e0b2F07d9f9A9e5b40b674A1e7dBC2471c76984)
- Leaf: `sha256(readId|vaultId|appId|folders|items|timestamp)`
- Tree: sha256 pairs, last node duplicated on odd levels
- `roots(hour)` returns the root written for that UTC hour

The vault's Read log can rebuild the proof for any of your reads in the browser and compare it with the root stored on-chain.

## Connector (MCP)

One file, no dependencies, Node 18+. It decrypts the folders an app may read on your own machine.

```json
{
  "mcpServers": {
    "axon": {
      "command": "node",
      "args": ["/path/to/axon-connector.mjs"],
      "env": { "AXON_KEY": "axon_your_app_key", "AXON_URL": "https://axonsignal.fun" }
    }
  }
}
```

Tools: `axon_self`, `axon_folders`, `axon_read_folder`, `axon_search`, `axon_suggest`.

## Stack

- Cloudflare Workers + D1 for the API and ciphertext storage ([`worker.js`](worker.js))
- Workers AI for Signal answers ([`signal.js`](signal.js))
- secp256k1 recovery and keccak-256 written from scratch for holder checks ([`eth.js`](eth.js))
- Vanilla HTML, CSS and JS front end, no build step ([`public/`](public))
- Foundry for the seal contract, a small bot writes each hourly root ([`seal-bot.mjs`](seal-bot.mjs))

## Run your own

```bash
npx wrangler d1 create axon-db          # put the id in wrangler.toml
npx wrangler d1 execute axon-db --remote --file=schema.sql
npx wrangler deploy
```

## License

MIT
