# Python's harder shapes (test/proj/semantics.py): async, generators, classes, decorators, threads, caps, odd values.
import unittest

from test_agent import run_app


class Semantics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        run = run_app(script="semantics.py")
        assert run.stderr == "", run.stderr
        cls.events = [e for _, _, m in run.got if m["type"] == "events" for e in m["events"]]
        cls.byid = {e["id"]: e for e in cls.events}
        cls.reqs = {e["name"].split(" /")[1]: e for e in cls.events if e["kind"] == "http_request"}

    def steps(self, which, name=None):
        tid = self.reqs[which]["traceId"]
        return [e for e in self.events if e["traceId"] == tid and e["kind"] == "function" and (name is None or e["name"] == name)]

    def parent(self, e):
        return self.byid[e["parentId"]]["name"]

    def test_class_methods_static_class_and_property_by_qualname(self):
        names = {e["name"] for e in self.steps("classes")}
        self.assertLessEqual({"Cart.__init__()", "Cart.total()", "Cart.tax()", "Cart.empty()", "Cart.count()"}, names)
        (tax,) = self.steps("classes", "Cart.tax()")
        self.assertEqual((self.parent(tax), tax["args"], tax["returned"]), ("Cart.total()", ["amount=300"], "30"))
        (empty,) = self.steps("classes", "Cart.empty()")
        self.assertEqual(empty["args"], [], "cls is not an argument worth showing")

    def test_decorated_function_nests_under_its_wrapper_and_points_at_its_def(self):
        (inner,) = self.steps("classes", "discounted()")
        self.assertEqual((self.parent(inner), inner["args"], inner["returned"]), ("logged.<locals>.wrapper()", ["price=200", "pct=10"], "180"))
        self.assertEqual(inner["source"]["line"], 38, "the def line, not the @logged line above it")

    def test_recursion_records_the_first_64_levels_and_says_so(self):
        dives = self.steps("recursion", "dive()")
        self.assertEqual(len(dives), 63, "handler() is level 1")
        notes = [e for e in self.events if e["traceId"] == self.reqs["recursion"]["traceId"] and e["kind"] == "log"]
        self.assertEqual([n["log"]["message"] for n in notes], ["Shrike skipped steps nested more than 64 calls deep."])
        self.assertEqual(notes[0]["log"]["level"], "warn")

    def test_hot_loop_caps_steps_per_request_and_says_so(self):
        self.assertEqual(len(self.steps("hot")), 2000)
        notes = [e["name"] for e in self.events if e["traceId"] == self.reqs["hot"]["traceId"] and e["kind"] == "log"]
        self.assertEqual(notes, ["Shrike recorded the first 2000 steps of this request and skipped the rest."])
        self.assertEqual(len(self.steps("errors")), 8, "the cap is per request: other requests are whole")

    def test_only_escaping_exceptions_are_errors(self):
        risky = self.steps("errors", "risky()")
        self.assertEqual([e["status"] for e in risky], ["error", "error"])
        (safe,) = self.steps("errors", "safe()")
        self.assertEqual((safe["status"], safe["returned"]), ("ok", "'handled'"))
        (rethrow,) = self.steps("errors", "rethrow()")
        self.assertEqual((rethrow["status"], rethrow["error"]["type"]), ("error", "ValueError"))
        req = self.reqs["errors"]
        self.assertEqual((req["status"], req["error"]["type"], req["http"]["status"]), ("error", "ValueError", 500))

    def test_generators_hand_control_back_to_their_consumer(self):
        (total,) = self.steps("generators", "total_of()")
        gens = self.steps("generators", "numbers()")
        self.assertEqual(sorted(self.parent(g) for g in gens), ["first_of()", "total_of()"])
        self.assertTrue(all(g["status"] == "ok" for g in gens), "a generator closed early is not an error")
        notes = self.steps("generators", "note()")
        self.assertEqual([self.parent(n) for n in notes], ["total_of()"] * 3 + ["handler()"] * 2, "work between yields belongs to the consumer")
        (ticks,) = self.steps("generators", "ticks()")
        self.assertEqual((self.parent(ticks), ticks["status"]), ("handler()", "ok"))
        self.assertEqual(total["returned"], "3")

    def test_threads_keep_the_request_when_the_context_is_copied(self):
        works = self.steps("threads", "work()")
        self.assertEqual([(w["args"], self.parent(w)) for w in works], [(["n=2"], "handler()")], "asyncio.to_thread copies the context; a bare executor doesn't, and isn't recorded")
        self.assertEqual(self.reqs["threads"]["status"], "ok")

    def test_huge_cyclic_and_unprintable_values_are_capped_and_never_crash(self):
        (big,) = self.steps("values", "big()")
        self.assertEqual(big["returned"], "100000")
        args = dict(a.split("=", 1) for a in big["args"])
        self.assertTrue(all(len(v) <= 2048 + len("…[truncated]") for v in args.values()), args)
        self.assertIn("...", args["numbers"])
        self.assertTrue(args["blob"].startswith("b'xxx") and args["blob"].endswith("..."))
        self.assertIn("[...]", args["cyclic"])
        self.assertIn("Loud", args["loud"])
        self.assertEqual(args["chatty"], "Chatty(1)")
        self.assertFalse(self.steps("values", "note()"), "a __repr__ that calls the app's code is not recorded as a step")

    def test_secrets_masked_in_arguments_and_values(self):
        (login,) = self.steps("secrets", "login()")
        self.assertEqual(login["args"], ["username='ada'", "password=[redacted]", "api_key=[redacted]", "headers={'Authorization': [redacted], 'accept': '*/*'}", "token=[redacted]"])
        self.assertEqual(login["returned"], "{'user': 'ada', 'session': [redacted]}")

    def test_django_orm_queries_through_its_own_cursor_class_without_its_bookkeeping(self):
        tid = self.reqs["orm"]["traceId"]
        queries = [e for e in self.events if e["traceId"] == tid and e["kind"] == "db_query"]
        self.assertEqual([(q["db"]["statement"], q["db"].get("params"), q["place"]["id"]) for q in queries], [("SELECT %s", "('ada',)", "data:sqlite::memory:")], "no PRAGMA from the connection's setup, no QUOTE(?) from DEBUG")

    def test_concurrent_requests_keep_their_own_steps(self):
        for which, n in (("concurrent1", "n=1"), ("concurrent2", "n=2")):
            (work,) = self.steps(which, "work()")
            handler = self.byid[work["parentId"]]
            self.assertEqual((work["args"], handler["name"], handler["parentId"]), ([n], "handler()", self.reqs[which]["id"]))


if __name__ == "__main__":
    unittest.main()
