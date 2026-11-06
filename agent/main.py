"""Minimal AgentCore Runtime entrypoint for Phase 0.

The starter deliberately performs no model inference and has no product tools.  It
only proves that the same entrypoint can be imported, started, and invoked by the
AgentCore Runtime SDK.  Feature-phase code will add the bounded investigation
wrapper and Strands model construction around this entrypoint.
"""

from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp


app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload: Any) -> dict[str, Any]:
    """Return a deterministic local smoke response without credentials."""

    if not isinstance(payload, dict):
        return {"status": "ok", "message": "agent runtime ready", "payload_type": type(payload).__name__}
    return {
        "status": "ok",
        "message": "agent runtime ready",
        "received_keys": sorted(str(key) for key in payload),
    }


if __name__ == "__main__":
    app.run()
