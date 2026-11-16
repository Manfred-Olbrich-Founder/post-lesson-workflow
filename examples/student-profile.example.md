# Example STUDENT PROFILE

This is an invented student. It shows the layout the script reads. In real use this is a Google Doc called `STUDENT PROFILE` inside the student's folder.

The script reads only these parts:

- the first email address under `STUDENT` (the draft goes **to** this address)
- the first email address under `PARENTS / GUARDIANS` (this address is put in **cc**)
- `Preferred name:` (used to match the student to a meeting, and in the greeting)
- `Subject and level:` under `COURSE` (used in file names and the email subject)

The whole profile is also given to the AI as background, so tone notes and goals shape the email.

```
STUDENT PROFILE

STUDENT
Full name: Alex Example
Preferred name: Alex
Email: alex.example@example.com
School year: Year 12

PARENTS / GUARDIANS
Name: Jordan Example
Email: jordan.example@example.com

LESSON EMAILS
Tone notes: Warm and encouraging. Short sentences. Alex responds well to specific praise.

COURSE
Subject and level: A-Level Maths
Exam board: Edexcel

ASPIRATIONS
Target grade: A
Plans: Engineering at university
```
