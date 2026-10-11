import { serve } from "../../shared/http.ts";
import { getCartRoute, listProductsRoute } from "./routes/catalog.ts";
import { placeOrderRoute } from "./routes/orders.ts";

serve("gateway", {
  "GET /api/products": listProductsRoute,
  "GET /api/cart": getCartRoute,
  "POST /api/orders": placeOrderRoute,
});
