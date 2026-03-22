import { buildMessage } from "./shared";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";

export async function handler() {
  const s3 = new S3Client({});
  const sqs = new SQSClient({});

  console.log("S3 Client:", s3);
  console.log("SQS Client:", sqs);

  return buildMessage("goodbye");
}
