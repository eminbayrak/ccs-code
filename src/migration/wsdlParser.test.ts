import { expect, test, describe } from "bun:test";
import { parseWsdl, wsdlToPromptText } from "./wsdlParser.js";

const SAMPLE_WSDL = `<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:xs="http://www.w3.org/2001/XMLSchema"
                  xmlns:tns="http://example.com/order"
                  targetNamespace="http://example.com/order"
                  name="OrderService">

  <wsdl:types>
    <xs:schema targetNamespace="http://example.com/order">
      <xs:element name="GetOrderRequest">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="orderId" type="xs:string"/>
            <xs:element name="includeItems" type="xs:boolean" minOccurs="0"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="GetOrderResponse">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="orderId" type="xs:string"/>
            <xs:element name="status" type="xs:string"/>
            <xs:element name="total" type="xs:decimal"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:schema>
  </wsdl:types>

  <wsdl:message name="GetOrderRequest">
    <wsdl:part name="parameters" element="tns:GetOrderRequest"/>
  </wsdl:message>
  <wsdl:message name="GetOrderResponse">
    <wsdl:part name="parameters" element="tns:GetOrderResponse"/>
  </wsdl:message>

  <wsdl:portType name="OrderServiceSoap">
    <wsdl:operation name="GetOrder">
      <wsdl:input message="tns:GetOrderRequest"/>
      <wsdl:output message="tns:GetOrderResponse"/>
    </wsdl:operation>
  </wsdl:portType>

  <wsdl:service name="OrderService">
    <wsdl:port name="OrderServiceSoap" binding="tns:OrderServiceSoap">
      <soap:address location="https://example.com/order.asmx"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;

describe("parseWsdl", () => {
  test("extracts service name", () => {
    const result = parseWsdl(SAMPLE_WSDL);
    expect(result.serviceName).toBe("OrderService");
  });

  test("extracts target namespace", () => {
    const result = parseWsdl(SAMPLE_WSDL);
    expect(result.targetNamespace).toBe("http://example.com/order");
  });

  test("extracts operations", () => {
    const result = parseWsdl(SAMPLE_WSDL);
    expect(result.operations.length).toBeGreaterThanOrEqual(1);
    const op = result.operations.find((o) => o.name === "GetOrder");
    expect(op).toBeTruthy();
  });

  test("extracts input message name", () => {
    const result = parseWsdl(SAMPLE_WSDL);
    const op = result.operations.find((o) => o.name === "GetOrder");
    expect(op?.inputMessage).toBe("GetOrderRequest");
  });

  test("extracts output message name", () => {
    const result = parseWsdl(SAMPLE_WSDL);
    const op = result.operations.find((o) => o.name === "GetOrder");
    expect(op?.outputMessage).toBe("GetOrderResponse");
  });

  test("returns empty operations for empty WSDL", () => {
    const result = parseWsdl('<definitions targetNamespace="http://x.com"/>');
    expect(result.operations).toHaveLength(0);
    expect(result.serviceName).toBeNull();
  });

  test("does not throw on malformed XML", () => {
    expect(() => parseWsdl("not xml at all {{ broken")).not.toThrow();
  });
});

describe("wsdlToPromptText", () => {
  test("formats operation list for LLM", () => {
    const result = parseWsdl(SAMPLE_WSDL);
    const text = wsdlToPromptText(result);
    expect(text).toContain("GetOrder");
    expect(text).toContain("OrderService");
  });

  test("handles empty operations gracefully", () => {
    const text = wsdlToPromptText({ operations: [], targetNamespace: null, serviceName: null });
    expect(text).toBe("No WSDL operations found.");
  });
});
