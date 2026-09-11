"""What a review cost, from the token counts the API reports.

Prices are US dollars per million tokens, from Anthropic's published rates. Cache writes
(5-minute TTL) cost 1.25x the input rate and cache reads 0.1x — which is why caching the
stable prefix matters for an agent that re-sends its whole conversation every turn.
"""

from ..models import Usage

# (input, output) per million tokens.
PRICES = {
    "claude-opus-5": (5.00, 25.00),
    "claude-opus-4-8": (5.00, 25.00),  # the default refusal fallback for some categories
    "claude-sonnet-5": (2.00, 10.00),
    "claude-haiku-4-5": (1.00, 5.00),
}

CACHE_WRITE_MULTIPLIER = 1.25
CACHE_READ_MULTIPLIER = 0.10


def cost_usd(model: str, usage: Usage) -> float | None:
    """Dollars for this usage, or None for a model not in the table — never a guess."""
    price = PRICES.get(model)
    if price is None:
        return None
    input_rate, output_rate = (p / 1_000_000 for p in price)
    return (
        usage.input_tokens * input_rate
        + usage.cache_creation_input_tokens * input_rate * CACHE_WRITE_MULTIPLIER
        + usage.cache_read_input_tokens * input_rate * CACHE_READ_MULTIPLIER
        + usage.output_tokens * output_rate
    )
