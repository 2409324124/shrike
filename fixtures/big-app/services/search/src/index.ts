import { serve } from "../../shared/http.ts";
import { reindexRoute, relatedRoute } from "./routes/search.ts";

serve("search", { "POST /related": relatedRoute, "POST /admin/reindex": reindexRoute });
