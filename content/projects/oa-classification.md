---
title: AI-Powered Osteoarthritis Classification & Reporting
summary: "Knee X-ray to a doctor's report in under two minutes: Kellgren–Lawrence grading at 98% accuracy and AUC, double-checked by segmentation of the radiological findings, tested in a randomised controlled trial and deployed at Fortis."
org: OsteosConnect
period: Jan 2024 – Sep 2024
tags: [Computer Vision, Medical Imaging, Segmentation, TensorFlow, AWS, EC2 H100, Lambda, API Gateway]
featured: true
order: 2
keywords: [osteoarthritis, oa, knee, x-ray, medical imaging, kellgren lawrence, kl grade, segmentation, osteophytes, sclerosis, joint space, randomised controlled trial, rct, srm trichy, fortis, nagarbhavi, tensorflow, h100, lambda, api gateway, ec2, fda, patents, radiologist, rbknee, healthcare, classification, report]
skills: ["TensorFlow", "computer vision", "deep learning", "CNNs", "segmentation models", "X-ray annotation", "classification", "AWS (S3, Lambda, SageMaker, EC2, Bedrock)", "healthcare automation", "DICOM processing", "PyDICOM", "Python"]
---

## What it does
A doctor uploads a knee X-ray. **In under two minutes** the system grades the osteoarthritis, finds and measures every
radiological finding, writes the report and forwards it to the doctor.

## How it works
1. **Grade.** A classification model grades the X-ray on the **Kellgren–Lawrence (KL) scale** at **98% accuracy and
   AUC**.
2. **Find.** Purpose-built image segmentation models locate the radiological findings: **osteophytes, subchondral
   sclerosis and the gap between the joints** (joint-space narrowing).
3. **Double-check.** The findings are matched against the step-1 grade, so a grade the evidence doesn't support is
   caught before it reaches a doctor.
4. **Measure.** The system calculates the **length and area** of each finding.
5. **Report.** It writes the report and forwards it to the doctor, end to end in less than two minutes.

Every model was **custom-built** in-house, with patent filings and FDA approval in mind.

## Clinical validation and deployment
- Tested at **SRM, Trichy** as part of a **randomised controlled trial** of osteoarthritis patients, under the
  supervision of **Dr. Mahesh Magadum**.
- More than 90% concordance with radiologists; outperformed competitor RBKnee.
- **Deployed and scaled at Fortis Hospital, Nagarbhavi, Bengaluru.**

## Stack
- **TensorFlow** for every model: the KL classifier and the segmentation models.
- Training and inference on **AWS EC2 with an H100 GPU cluster**.
- Serving through **AWS Lambda** functions behind **API Gateway**, with the report delivered to the doctor.

## Rishabh's role
He led the clinicians and engineers who delivered it. Earlier, as an intern, he ran EDA on DICOM images and built the
baseline classifiers (logistic regression, random forest) before the move to deep learning. Follow-on research, "OA
Classification and Reporting using Agentic AI and Deep Neural Networks", is ongoing with OsteosConnect.
