# Changelog

## PI Web — In-Process SDK & Resilience Update

🚀 **PI Web Update**

• PI driver migrated to the native in-process AgentSession SDK — pooled broadcast + usage/cost tracking
• DB-backed settings with cross-tab sync + full structured settings.json editor
• Live sessions survive reload, network blips, SW updates & device switches — ~30 reconnect edge cases closed across 4 layers
• Double-click force-stop kills the agent cleanly
• Background polls keep sessions & git status fresh
• Chat UX: header context bar, tool calls collapse by default, auto-expand prefs

_Covers commits `c6a6967..HEAD` (8 commits)._
