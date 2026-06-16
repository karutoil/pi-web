FROM oven/bun:1.2

# Install git, bash, ripgrep, and networking tools for pi agents, terminals, and search
RUN apt-get update && apt-get install -y git bash lsof procps iproute2 ripgrep && rm -rf /var/lib/apt/lists/*

# The bundled @earendil-works/pi-coding-agent dependency provides a `pi` CLI shim
# with a `#!/usr/bin/env node` shebang. Make the image self-contained by
# treating Bun as `node` so the shim works without installing a separate Node runtime.
RUN ln -sf /usr/local/bin/bun /usr/local/bin/node

WORKDIR /app

# Make the bundled `pi` binary discoverable by the server (and by pi itself).
ENV PATH="/app/node_modules/.bin:${PATH}"

# Copy root workspace files for layer caching
COPY package.json ./
COPY bun.lock* ./
COPY packages/client/package.json packages/client/
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/

# Install workspace dependencies
RUN bun install

# Copy full source (includes scripts/docker-entrypoint.sh)
COPY . .

# Dockerfile/docker-compose.yml are excluded from context but tracked in git.
# Mark them assumed-unchanged so git status doesn't report them as deleted.
RUN git update-index --assume-unchanged Dockerfile docker-compose.yml || true

# Bake version metadata so the image can report its git sync state without
# shipping the entire .git directory in the final layer.
RUN bun run scripts/bake-version.ts
RUN rm -rf .git

# Remove any workspace-level node_modules copied from the host.
# Bun installs all dependencies into the root node_modules and resolves them
# from there; stale per-package symlinks cause ENOENT on some Bun versions.
RUN rm -rf packages/*/node_modules

# Build shared types and client dist
RUN bun run build

# Make entrypoint executable
RUN chmod +x /app/scripts/docker-entrypoint.sh

ENV NODE_ENV=production

EXPOSE 3069

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["bun", "run", "--cwd", "packages/server", "start"]
