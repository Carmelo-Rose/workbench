"""White-field normalisation nodes for the product cutout workflow.

Pure numpy/OpenCV -- no model weights and no network access, so the package
loads on any ComfyUI install that already has cv2.
"""

from .nodes_whitefield import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
