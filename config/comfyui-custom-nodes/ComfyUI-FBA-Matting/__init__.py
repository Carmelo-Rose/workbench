"""FBA matting nodes used by the product cutout workflow.

The official FBA implementation and weights stay outside this plugin.  The
node imports that checkout lazily so ComfyUI can start even when the optional
matting model is not installed.
"""

from .nodes_fba import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
