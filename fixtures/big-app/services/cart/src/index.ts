import { serve } from "../../shared/http.ts";
import { getCartRoute } from "./routes/carts.ts";

serve("cart", { "GET /carts/:userId": getCartRoute });
