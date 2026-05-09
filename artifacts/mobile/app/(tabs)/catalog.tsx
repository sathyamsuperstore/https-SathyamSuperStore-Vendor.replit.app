import React from "react";
import { HubTab } from "@/components/HubTab";
import PromoScreen from "./promo";
import BrandReviewScreen from "./brand-review";
import PromoPrintScreen from "./promoprint";

export default function CatalogHubScreen() {
  return (
    <HubTab
      defaultView="promo"
      views={[
        { key: "promo", label: "Promo", render: () => <PromoScreen /> },
        {
          key: "promoPrev",
          label: "PromoPrev",
          render: () => <PromoScreen mode="prev" />,
        },
        {
          key: "promoPrint",
          label: "PromoPrint",
          render: () => <PromoPrintScreen />,
        },
        {
          key: "brand",
          label: "Brand Review",
          render: () => <BrandReviewScreen />,
        },
      ]}
    />
  );
}
