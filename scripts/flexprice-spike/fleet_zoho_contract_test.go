package zoho

import (
	"context"
	"testing"

	"github.com/flexprice/flexprice/internal/types"
	"github.com/shopspring/decimal"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestFleetGrossGSTInvoiceContract locks AI Fleet's Probe C invoice shape to
// the native Zoho request produced by the pinned FlexPrice implementation.
func TestFleetGrossGSTInvoiceContract(t *testing.T) {
	inv := buildTestInvoice("INR", "0", "", "", []testLineItem{
		{name: "Platform credits", priceID: "fleet_principal", amount: "500"},
		{name: "CGST @ 9%", priceID: "fleet_cgst", amount: "45"},
		{name: "SGST @ 9%", priceID: "fleet_sgst", amount: "45"},
	})
	svc, client := newSyncTestService(inv, nil)
	svc.customerRepo = &fakeSyncCustomerRepo{metadata: map[string]string{
		types.MetadataKeyGSTIN: "24AAMCM4148E1ZB",
	}}

	_, err := svc.SyncInvoiceToZoho(context.Background(), ZohoInvoiceSyncRequest{InvoiceID: inv.ID})
	require.NoError(t, err)
	require.NotNil(t, client.createInvoiceReq)

	req := client.createInvoiceReq
	assert.Equal(t, "24", req.PlaceOfSupply, "place of supply must be pinned from the customer's GSTIN")
	require.Len(t, req.LineItems, 3)

	wantNames := []string{"Platform credits", "CGST @ 9%", "SGST @ 9%"}
	wantRates := []decimal.Decimal{
		decimal.NewFromInt(500),
		decimal.NewFromInt(45),
		decimal.NewFromInt(45),
	}
	total := decimal.Zero
	for i, line := range req.LineItems {
		assert.Equal(t, wantNames[i], line.Name)
		assert.Truef(t, wantRates[i].Equal(line.Rate), "line %d rate = %s, want %s", i, line.Rate, wantRates[i])
		assert.Truef(t, decimal.NewFromInt(1).Equal(line.Quantity), "line %d quantity = %s, want 1", i, line.Quantity)
		assert.Empty(t, line.TaxID, "AI Fleet GST lines are gross amounts, not Zoho tax overrides")
		assert.Empty(t, line.TaxExemptionID, "AI Fleet GST lines must not carry a Zoho tax exemption")
		total = total.Add(line.Rate.Mul(line.Quantity))
	}
	assert.Truef(t, decimal.NewFromInt(590).Equal(total), "native Zoho line total = %s, want 590", total)
}
