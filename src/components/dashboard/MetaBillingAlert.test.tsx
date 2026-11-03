import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetaBillingAlertView } from "./MetaBillingAlert";

const base = {
  refusals: 12,
  lastRefusalAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  lastDeliveredAt: null,
};

describe("MetaBillingAlertView", () => {
  it("renders nothing when there is no warning", () => {
    const { container } = render(<MetaBillingAlertView state="none" signal={base} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the billing alert with the count and the Meta code", () => {
    render(<MetaBillingAlertView state="active" signal={base} />);
    expect(screen.getByRole("alert")).toHaveTextContent("בעיית תשלום");
    expect(screen.getByRole("alert")).toHaveTextContent("12 טמפלייטים נחסמו");
    expect(screen.getByText("131042")).toBeInTheDocument();
  });

  it("shows the quiet recovered note once a send got through", () => {
    render(
      <MetaBillingAlertView
        state="recovered"
        signal={{ ...base, lastDeliveredAt: new Date().toISOString() }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("כנראה נפתרה");
    expect(screen.getByRole("alert")).toHaveTextContent("היו 12 חסימות תשלום");
  });
});
