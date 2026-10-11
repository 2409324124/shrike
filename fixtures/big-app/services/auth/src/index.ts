import { serve } from "../../shared/http.ts";
import { verifyRoute } from "./routes/sessions.ts";

serve("auth", { "POST /sessions/verify": verifyRoute });
