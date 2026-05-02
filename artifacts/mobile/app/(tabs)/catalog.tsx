import React from "react";
import { HubTab } from "@/components/HubTab";
import MrpScreen from "./mrp";
import PromoScreen from "./promo";
import BrandReviewScreen from "./brand-review";

export default function CatalogHubScreen() {
  return (
    <HubTab
      defaultView="mrp"
      views={[
        { key: "mrp", label: "MRP", render: () => <MrpScreen /> },
        { key: "promo", label: "Promo", render: () => <PromoScreen /> },
        {
          key: "brand",
          label: "Brand Review",
          render: () => <BrandReviewScreen />,
        },
      ]}
    />
  );
}
