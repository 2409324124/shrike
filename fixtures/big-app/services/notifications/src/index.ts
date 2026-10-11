import { serve } from "../../shared/http.ts";
import { orderPlacedRoute } from "./routes/events.ts";

serve("notifications", { "POST /events/order-placed": orderPlacedRoute });
