---
title: AI-Powered Osteoarthritis Classification & Reporting
summary: End-to-end knee X-ray grading on AWS — 96% accuracy, more than 90% concordance with radiologists, ahead of competitor RBKnee.
org: OsteosConnect
period: Jan 2024 – Sep 2024
tags: [Computer Vision, Medical Imaging, AWS, SageMaker, Feedback loop]
featured: true
order: 2
keywords: [osteoarthritis, oa, knee, x-ray, medical imaging, sagemaker, s3, lambda, ec2, emr, radiologist, rbknee, srm trichy, healthcare, classification]
---

## What it does
Doctors capture a knee X-ray on a React web app or an Android app. The system grades osteoarthritis automatically and produces a web-based report.

## How it works
- **Flow:** capture on React/Android → encrypted upload to S3 → Lambda trigger → SageMaker/EC2 inference → prediction → Lambda → report written to the EMR.
- A **closed feedback loop** retrains the model on doctor-validated labels, so it keeps improving with real clinical use.
- Earlier, as an intern, Rishabh ran EDA on DICOM images and built baseline classifiers (logistic regression, random forest) before moving to deep learning.

## Results
- **96% classification accuracy.**
- More than 90% concordance with radiologists in trials at SRM Trichy.
- Outperformed competitor RBKnee.
- Rishabh led the clinicians and engineers who delivered it.
- Follow-on research, "OA Classification and Reporting using Agentic AI and Deep Neural Networks", is ongoing with OsteosConnect.
