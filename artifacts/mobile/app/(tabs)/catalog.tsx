import React from "react";
import { HubTab } from "@/components/HubTab";
import PromoScreen from "./promo";
import BrandReviewScreen from "./brand-review";
import PromoPrintScreen from "./promoprint";
import PriceTagPreviewScreen from "../pricetag-preview";
import PriceTagReviewScreen from "../pricetag-review";
import TitleListScreen from "../title-list";

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
          key: "priceTagPreview",
          label: "PriceTag Preview",
          render: () => <PriceTagPreviewScreen />,
        },
        {
          key: "priceTagReview",
          label: "PriceTag Review",
          render: () => <PriceTagReviewScreen />,
        },
        {
          key: "titleList",
          label: "TitleList",
          render: () => <TitleListScreen />,
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
