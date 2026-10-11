import { serve } from "../../shared/http.ts";
import { recsRoute } from "./routes/recs.ts";

serve("recommendations", { "GET /for/:userId": recsRoute });
