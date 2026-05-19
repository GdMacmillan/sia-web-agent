import { jsonTransformer, csvTransformer } from "../src/transformers/index.js";

describe("Transformers", () => {
  describe("jsonTransformer", () => {
    it("should convert object to JSON string", () => {
      const obj = { name: "John", age: 30 };
      const json = jsonTransformer.to(obj);
      expect(json).toContain('"name"');
      expect(json).toContain('"John"');
    });

    it("should convert JSON string to object", () => {
      const json = '{"name":"John","age":30}';
      const obj = jsonTransformer.from(json);
      expect(obj.name).toBe("John");
      expect(obj.age).toBe(30);
    });

    it("should validate objects correctly", () => {
      const valid = jsonTransformer.validate({ test: true });
      expect(valid.valid).toBe(true);

      const invalid = jsonTransformer.validate([1, 2, 3]);
      expect(invalid.valid).toBe(false);
    });
  });

  describe("csvTransformer", () => {
    it("should convert array of objects to CSV", () => {
      const data = [
        { name: "John", age: "30" },
        { name: "Jane", age: "25" },
      ];
      const csv = csvTransformer.to(data);
      expect(csv).toContain("name,age");
      expect(csv).toContain("John,30");
      expect(csv).toContain("Jane,25");
    });

    it("should convert CSV to array of objects", () => {
      const csv = "name,age\nJohn,30\nJane,25";
      const data = csvTransformer.from(csv);
      expect(data).toHaveLength(2);
      expect(data[0].name).toBe("John");
    });

    it("should validate arrays of objects", () => {
      const valid = csvTransformer.validate([{ x: 1 }, { x: 2 }]);
      expect(valid.valid).toBe(true);

      const invalid = csvTransformer.validate("not an array");
      expect(invalid.valid).toBe(false);
    });
  });
});
