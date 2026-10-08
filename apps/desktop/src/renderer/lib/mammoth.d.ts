declare module "mammoth/mammoth.browser.js" {
  const mammoth: { convertToHtml(input: { arrayBuffer: ArrayBuffer }, options?: { externalFileAccess?: boolean }): Promise<{ value: string }> };
  export default mammoth;
}
