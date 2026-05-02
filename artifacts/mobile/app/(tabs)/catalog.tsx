import React from "react";
import { HubTab } from "@/components/HubTab";
import PromoScreen from "./promo";
import BrandReviewScreen from "./brand-review";

export default function CatalogHubScreen() {
  return (
    <HubTab
      defaultView="promo"
      views={[
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
