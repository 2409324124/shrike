import { serve } from "../../shared/http.ts";
import { exportRoute, listRoute, productRoute, quoteRoute } from "./routes/products.ts";

serve("catalog", {
  "GET /products": listRoute,
  "GET /products/export": exportRoute,
  "GET /products/:id": productRoute,
  "POST /quote": quoteRoute,
});
