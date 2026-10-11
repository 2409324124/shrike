import { serve } from "../../shared/http.ts";
import { publishRoute } from "./routes/topics.ts";

serve("queue", { "POST /topics/:topic/messages": publishRoute });
