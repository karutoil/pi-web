FROM oven/bun:1.2

# Install tools for pi agents, terminals, search, and git over HTTPS/SSH.
# ca-certificates + openssh-client are pulled in transitively by git today,
# but listed explicitly so HTTPS clone / git@ / ssh:// keep working if that
# dependency ever changes. curl covers pi's install.sh and common dev workflows.
# DB clients (psql/mysql/sqlite3) let the agent reach host databases via
# host.docker.internal instead of only seeing them on a screenshot.
# ponytail: rustc/cargo via apt (bookworm ~1.63, old but compiles most crates).
#   If a crate needs a current toolchain, swap for rustup into /usr/local/bin
#   (compose overrides PATH, so it must land on a dir already on it, not ~/.cargo).
RUN apt-get update && apt-get install -y \
      git ca-certificates openssh-client curl bash lsof procps iproute2 ripgrep \
      postgresql-client default-mysql-client sqlite3 rustc cargo \
    && rm -rf /var/lib/apt/lists/*

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
