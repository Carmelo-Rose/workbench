# Product

## Register

product

## Users

Workbench is for creators and operators using it as an AI creation workbench. They need a fast chat-first surface for image prompt reverse engineering, video analysis, Image2 workflows, and material handling.

## Product Purpose

Workbench is the enterprise-level platform: the primary product that the other tools (including the Mono Chrome extension) plug into. The immediate goal is to use the existing assistant-ui Base source as the interaction foundation: thread history, focused chat workspace, composer, suggestions, and tool-rendered results — as the base for that platform surface.

## Brand Personality

Restrained, capable, workbench-like. The interface should feel like a serious creation tool rather than a marketing page or decorative prototype.

## Anti-references

Do not ship the default create-next-app screen, a narrow standalone chat demo, or a decorative landing page. Avoid adding unrelated top-level tabs when the assistant-ui workbench source already provides the intended app shell.

## Design Principles

- Reuse the assistant-ui Base source as the primary UI pattern.
- Keep tool-specific capabilities available through tool UI and API routes.
- Favor a product workspace shell with thread navigation over a single centered demo.
- Preserve extensibility for future tools without expanding top-level visual noise.
- Make the first screen usable, not explanatory.

## Accessibility & Inclusion

Follow the accessibility behavior already present in assistant-ui and shadcn-derived controls: keyboard focus states, semantic buttons, tooltip labels for icon controls, and reduced-motion-compatible state transitions.
tions.
