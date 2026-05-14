## Force-sync Lovable to GitHub `main`

Lovable's GitHub integration is bidirectional: whatever sits on `main` in GitHub flows into Lovable automatically within seconds. I cannot run `git` commands from inside the sandbox (git state is managed by Lovable), so the sync has to be triggered from the GitHub side.

### Steps for you (one-time, ~1 minute)

1. From your local clone of `RicherLTD/richer-ai-agents-hub`:
   ```bash
   git fetch origin
   git checkout main
   git reset --hard origin/main      # ensure local main matches remote
   git push --force-with-lease origin main
   ```
   If `main` on GitHub is already at the commit you want, just an empty re-push is enough:
   ```bash
   git commit --allow-empty -m "chore: trigger lovable resync"
   git push origin main
   ```

2. Wait ~10–30 seconds. Lovable will pick up the new HEAD on `main` and rebuild the preview.

3. Ping me here with "synced" (or just send any message). I'll then:
   - Verify the working tree matches what you expect (spot-check a couple of files).
   - Run `bun run build` to confirm the preview builds cleanly.
   - Publish the new version to `https://ripple-agents.lovable.app`.

### Alternative — History rollback (no terminal needed)

If you'd rather not touch the CLI:
- Open the **History** panel (clock icon, top-right of the editor).
- Find the entry that matches commit `201736d` (or whichever commit on `main` you want).
- Click **Restore**. Lovable rolls the project back to that exact state and the GitHub repo follows.

### Why I can't do it for you

The sandbox blocks stateful git commands (`reset`, `push`, `checkout`, etc.) — only Lovable's internal sync layer can move the project's git HEAD. So either you push from your machine, or you use the History panel inside Lovable.

### Confirm before I proceed

Tell me which path you prefer (CLI force-push, empty commit, or History restore), or just confirm once GitHub `main` reflects the state you want and I'll handle build + publish.