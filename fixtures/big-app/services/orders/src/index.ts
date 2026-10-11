import { serve } from "../../shared/http.ts";
import { createOrderRoute } from "./routes/orders.ts";

serve("orders", { "POST /orders": createOrderRoute });
