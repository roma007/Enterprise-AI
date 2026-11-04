declare module 's3rver' {
  interface S3rverOptions {
    port?: number;
    address?: string;
    silent?: boolean;
    directory: string;
    resetOnClose?: boolean;
    configureBuckets?: Array<{ name: string; configs?: unknown[] }>;
  }

  interface S3rverAddress {
    address: string;
    port: number;
  }

  class S3rver {
    constructor(options: S3rverOptions);
    run(): Promise<S3rverAddress>;
    close(): Promise<void>;
  }

  export = S3rver;
}
