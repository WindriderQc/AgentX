"""Resolve and retain the existing worker lane's effective model context."""


def resolve(progress, model, read_lanes, *, remember=False):
    context = getattr(progress, 'model_context_size', None)
    lanes = None
    if context is None:
        lanes = read_lanes()
        context = next((lane.get('contextSize') for lane in lanes.values()
                        if lane.get('model') == model), None)
    if remember and progress is not None and type(context) is int and context > 0:
        progress.model_context_size = context
    return context, lanes
