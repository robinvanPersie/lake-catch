# AI Implementation Preview

This directory contains a small verification harness for the desktop -> MCP -> AI implementation path.

Generate a standalone HTML page from a synchronized design document:

```bash
LANHU_DOCUMENT_ID="your-document-id" node examples/ai-implementation/generate.mjs
```

The same command also writes `implementation-context.json` next to the HTML. This JSON manifest is the machine-readable implementation input: it includes the target canvas, compact tree, nodes, text/style fields, asset availability and implementation warnings. It is intended for an AI coding workflow or a project-specific renderer; the HTML remains a visual verification artifact.

The generator calls `get_implementation_context`, renders confirmed node bounds and text, and keeps unavailable assets as explicit placeholders. It does not use the full-page preview image as the implementation source.

The preview uses the root artboard as the coordinate frame. For a scrollable mobile page, the generated canvas keeps the artboard width and content height, so the result can be checked as a real page rather than as a scaled screenshot. The diagnostic panel shows `confirmed`/`partial`, platform-unit confidence, viewport information, and asset availability.

Optional arguments:

```bash
LANHU_DOCUMENT_ID="document-id" \
LANHU_IMPLEMENTATION_OUTPUT="examples/ai-implementation/index.html" \
LANHU_IMPLEMENTATION_MANIFEST="examples/ai-implementation/implementation-context.json" \
node examples/ai-implementation/generate.mjs
```

The generator does not select a document implicitly. This prevents a historical fixture from being mistaken for the current design. Pass a document ID explicitly, or set `LANHU_STATE_PATH` when using a non-default local state file.

The historical news-detail fixture was previously used for acceptance testing at approximately `375 x 3481` CSS pixels, 506 nodes, and 92 text nodes. Those numbers describe that fixture only and are not product limits or expected values for other designs.
