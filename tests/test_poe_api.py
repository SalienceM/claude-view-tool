import unittest

import httpx

from src.backend.poe_api import POE_BALANCE_URL, POE_MODELS_URL, fetch_poe_overview


class PoeApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_catalog_and_balance_are_combined_and_sorted(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == POE_MODELS_URL:
                self.assertNotIn("authorization", request.headers)
                return httpx.Response(200, json={"object": "list", "data": [
                    {"id": "older", "created": 1_700_000_000, "description": "Old"},
                    {"id": "newer", "created": 1_800_000_000_000, "description": "New"},
                ]})
            if str(request.url) == POE_BALANCE_URL:
                self.assertEqual(request.headers.get("authorization"), "Bearer poe-secret")
                return httpx.Response(200, json={"current_point_balance": 4321})
            return httpx.Response(404)

        result = await fetch_poe_overview(
            "poe-secret", transport=httpx.MockTransport(handler),
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["currentPointBalance"], 4321)
        self.assertEqual([item["id"] for item in result["models"]], ["newer", "older"])
        self.assertEqual(result["models"][1]["createdAt"], 1_700_000_000_000)
        self.assertEqual(result["catalogError"], "")
        self.assertEqual(result["balanceError"], "")

    async def test_missing_key_keeps_public_catalog_available(self):
        requested: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requested.append(str(request.url))
            return httpx.Response(200, json={"data": [{"id": "assistant", "created": 1}]})

        result = await fetch_poe_overview("", transport=httpx.MockTransport(handler))

        self.assertEqual(requested, [POE_MODELS_URL])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["modelCount"], 1)
        self.assertIsNone(result["currentPointBalance"])
        self.assertIn("API Key", result["balanceError"])

    async def test_balance_failure_does_not_hide_catalog(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == POE_MODELS_URL:
                return httpx.Response(200, json={"data": [{"id": "assistant", "created": 1}]})
            return httpx.Response(401, json={"detail": "Invalid token"})

        result = await fetch_poe_overview("bad", transport=httpx.MockTransport(handler))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["modelCount"], 1)
        self.assertIsNone(result["currentPointBalance"])
        self.assertIn("HTTP 401", result["balanceError"])
        self.assertNotIn("bad", result["balanceError"])


if __name__ == "__main__":
    unittest.main()
